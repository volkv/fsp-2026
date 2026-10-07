// The engine of the test on a declared grade against the database (docs/domain.md, 10.4–10.9; contracts 6.5, 9.1):
// an attempt starts only when the grade policy lets it and the specialization is open, slots are served one by one from
// the release, computed answers are scored at once, programs and QA test cases by the sandbox job — QA harnesses are
// run by the local Python as the sandbox would run them — and the procedure of the contract decides; the decision and
// the call to the owner of the category land in one transaction. A failure of the sandbox is never a verdict; an expired
// attempt has no decision; an annulment and a review (`ObjectionDecisions`) change the decisions and the owner of the
// category follows; a seeded attempt takes the same path without the sandbox. The bank is the fixture bank (tests/helpers/families.ts).
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, asc, desc, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessSubject } from '$lib/server/access/permissions';
import { annulAttempt } from '$lib/server/assessments/annul';
import { judgementNote } from '$lib/server/assessments/explain';
import { ensureAttestations } from '$lib/server/attestations/issue';
import { attestationStatementSchema } from '$lib/server/attestations/statement';
import { verifyAttestation } from '$lib/server/attestations/verify';
import { createReceiptSigner } from '$lib/server/fsp/receipts';
import type { ItemInstance } from '$lib/server/assessments/contract/bank';
import {
	CATALOG,
	blockDefinition,
	gradeDefinition,
	type SpecializationKey
} from '$lib/server/assessments/contract/catalog';
import type { CategoryChange } from '$lib/server/assessments/contract/policy';
import {
	answerItem,
	expireOverdue,
	startAttempt,
	startAttemptIn,
	type EngineDeps
} from '$lib/server/assessments/engine';
import { clearExpiredArtifacts } from '$lib/server/assessments/retention';
import { OWNER_STANDING, type GradeStanding } from '$lib/server/assessments/standing';
import {
	assignObjection,
	OBJECTION_DECISIONS,
	openObjection,
	resolveObjection
} from '$lib/server/categories/objections';
import { runSeededAttempt } from '$lib/server/assessments/seed-attempt';
import { attemptState, decisionView, testsOverview } from '$lib/server/assessments/views';
import {
	bankReleases,
	candidateCategories,
	demoSessions,
	gradeDecisions,
	productPolicies,
	testArtifacts,
	testAttempts,
	testItems
} from '$lib/server/db/schema';
import { JobFailure } from '$lib/server/jobs/handler';
import { cancelWaitingJobs } from '$lib/server/jobs/queue';
import { checkBankTree, fileTrajectoryStore, publishBankReleases } from '../../scripts/release-bank';
import { declareGrade, releaseFixtureBank, type FixtureBank } from '../helpers/bank';
import { attemptRunner, FakeSandbox, STRONG_CASES } from '../helpers/attempts';
import { createTestDatabase, type TestDatabase } from '../helpers/database';
import { createCandidate, createUser, randomSha256 } from '../helpers/factories';
import { fixtureFamilies } from '../helpers/families';

const V = CATALOG.version;
let database: TestDatabase;
const banks = new Map<SpecializationKey, FixtureBank>();

/** The owner of categories as the engine sees it, every change it names recorded. */
class MemoryStanding implements GradeStanding {
	calls: CategoryChange[] = [];
	async applyGradeDecisions(...args: Parameters<GradeStanding['applyGradeDecisions']>) {
		const change = await OWNER_STANDING.applyGradeDecisions(...args);
		this.calls.push(change);
		return change;
	}
}

/** The category in force of the candidate in the specialization, by the owner of categories. */
const categoryOf = (candidateId: string, specialization: SpecializationKey) =>
	database.db
		.select()
		.from(candidateCategories)
		.where(
			and(
				eq(candidateCategories.candidateId, candidateId),
				eq(candidateCategories.specialization, specialization),
				eq(candidateCategories.status, 'active')
			)
		)
		.then((rows) => rows[0] ?? null);

const sandbox = new FakeSandbox();

function deps(standing: GradeStanding, specialization: SpecializationKey): EngineDeps {
	const bank = banks.get(specialization);
	if (!bank) throw new Error(`no fixture bank of ${specialization}`);
	return { standing, modules: bank.modules };
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

const candidateIdOf = (subject: AccessSubject): string => {
	if (!subject.candidate) throw new Error('not a candidate');
	return subject.candidate.id;
};

const operatorSubject = (userId: string): AccessSubject => ({
	userId,
	via: 'session',
	candidate: null,
	membership: null,
	staff: { operator: true, admin: false, extraPermissions: [] }
});

const options = () => ({ now: new Date(), requestId: 'test-engine' });

const { runTestJob, takeAttempt } = attemptRunner({
	db: () => database.db,
	sandbox,
	deps,
	requestId: 'test-engine'
});

beforeAll(async () => {
	database = await createTestDatabase();
	await database.db.insert(productPolicies).values({
		kind: 'assessment_policy',
		version: 1,
		// A day: the hold of an open objection is what keeps artifacts longer.
		params: { artifact_retention_days: 1 },
		effectiveFrom: new Date('2026-01-01T00:00:00Z')
	});
	for (const specialization of ['frontend', 'backend', 'qa'] as const) {
		banks.set(specialization, await releaseFixtureBank(database.db, specialization));
	}
});

afterAll(async () => {
	await database.drop();
});

describe('starting an attempt', () => {
	it('refuses a closed specialization and a grade the policy does not let start', async () => {
		const standing = new MemoryStanding();
		const subject = await candidateSubject();
		await expect(
			startAttempt(
				database.db,
				deps(standing, 'frontend'),
				subject,
				{ specialization: 'data_ml', grade: 'junior' },
				options()
			)
		).rejects.toMatchObject({
			code: 'policy_violation',
			details: [expect.objectContaining({ code: 'specialization_closed' })]
		});
		await expect(
			startAttempt(
				database.db,
				deps(standing, 'frontend'),
				subject,
				{ specialization: 'frontend', grade: 'junior' },
				options()
			)
		).rejects.toMatchObject({ code: 'conflict', details: [expect.objectContaining({ code: 'not_declared' })] });
		await declareGrade(database.db, candidateIdOf(subject), 'frontend', 'junior');
		await expect(
			startAttempt(
				database.db,
				deps(standing, 'frontend'),
				subject,
				{ specialization: 'frontend', grade: 'middle' },
				options()
			)
		).rejects.toMatchObject({ code: 'conflict', details: [expect.objectContaining({ code: 'above_declared' })] });
		const overview = await testsOverview(database.db, subject, new Date());
		expect(overview.specializations.map((s) => s.key).sort()).toEqual(['backend', 'frontend', 'qa']);
		expect(
			overview.specializations.find((s) => s.key === 'frontend')?.options.find((o) => o.grade === 'junior')
		).toMatchObject({
			available: true,
			kind: 'declared'
		});
	});

	it('serves the first slot of the blueprint and keeps one attempt in progress at a time', async () => {
		const standing = new MemoryStanding();
		const subject = await candidateSubject();
		await declareGrade(database.db, candidateIdOf(subject), 'frontend', 'junior');
		await declareGrade(database.db, candidateIdOf(subject), 'backend', 'junior');
		const { attempt, outcome } = await startAttempt(
			database.db,
			deps(standing, 'frontend'),
			subject,
			{ specialization: 'frontend', grade: 'junior' },
			options()
		);
		expect(outcome.kind).toBe('next');
		const state = await attemptState(database.db, subject, attempt.id, new Date());
		expect(state.items).toHaveLength(1);
		expect(state.current).toBe(1);
		// The candidate sees the statement, never the key.
		expect(JSON.stringify(state)).not.toContain('"answer":{"kind"');
		await expect(
			startAttempt(
				database.db,
				deps(standing, 'backend'),
				subject,
				{ specialization: 'backend', grade: 'junior' },
				options()
			)
		).rejects.toMatchObject({ code: 'conflict', details: [expect.objectContaining({ code: 'attempt_in_progress' })] });
		await expect(
			answerItem(
				database.db,
				deps(standing, 'frontend'),
				subject,
				{ attemptId: attempt.id, seq: 2, payload: { kind: 'answer', answer: '1' }, signals: null },
				options()
			)
		).rejects.toMatchObject({ code: 'conflict', details: [expect.objectContaining({ code: 'item_not_current' })] });
	});
});

describe('a whole attempt', () => {
	it('confirms a strong candidate: the decision, the fact of the profile and the owner of the category in one go', async () => {
		const standing = new MemoryStanding();
		const subject = await candidateSubject();
		const candidateId = candidateIdOf(subject);
		await declareGrade(database.db, candidateId, 'frontend', 'junior');
		const { attempt } = await startAttempt(
			database.db,
			deps(standing, 'frontend'),
			subject,
			{ specialization: 'frontend', grade: 'junior' },
			options()
		);
		const end = await takeAttempt(subject, attempt.id, standing, 'frontend', { correct: true });
		expect(end.status).toBe('decided');
		const [decision] = await database.db.select().from(gradeDecisions).where(eq(gradeDecisions.attemptId, attempt.id));
		// Seven items in twentieths (the practice is a gate, not a summand): S = 140, C = 7 · 12 = 84.
		expect(decision).toMatchObject({
			outcome: 'confirmed',
			reason: 'sprt_upper',
			status: 'valid',
			items: 7,
			scoreSum: 140,
			cutSum: 84
		});
		expect(decision?.practice).toEqual({ score: 1, gateMinScore: 0.4, passed: true });
		expect(standing.calls).toEqual([{ action: 'assign', grade: 'junior' }]);
		const category = await categoryOf(candidateId, 'frontend');
		expect(category).toMatchObject({ decisionId: decision?.id, grade: 'junior' });
		// The stack is the defining blocks' and the practice language's (`confirmedStack`).
		expect(category?.confirmedSkillKeys).toContain('javascript');
		// The practice ran once in the sandbox with every test of every group.
		const practice = sandbox.requests.find((r) => r.tests[0]?.id === 'g1/1');
		expect(practice?.tests).toHaveLength(10);

		const view = await decisionView(database.db, subject, decision?.id ?? '', new Date());
		expect(view.explanation.title).toBe('Грейд подтверждён');
		expect(view.explanation.blocks.map((b) => b.code)).not.toContain('fe.code');
		expect(view.explanation.practice).toMatchObject({ score: 1, passed: true });
		expect(view.explanation.blocks.filter((b) => b.defining).every((b) => b.passed)).toBe(true);
		expect(view.explanation.doesNotCheck).toContain('Коммерческий опыт и его длительность');
		// The fixture bank is reviewed and rated by models of two lineages: the result says so.
		expect(view.judgement).toEqual({ rubricByModelsOnly: true, angoffProvisional: true, sameVendorReviewer: false });
		expect(judgementNote(view.judgement)).toBe(
			'Рубрики заданий проверены независимыми моделями, пороги предварительные — их подтверждают эксперты.'
		);
		// The confirmation of the category by QR says the same in its signed statement (domain 12.9).
		const [attestation] = await database.db.transaction((tx) =>
			ensureAttestations(
				tx,
				createReceiptSigner({ issuer: 'http://localhost', keyId: 'test-1', seed: randomBytes(32) }),
				{
					candidateId,
					holder: { last: 'Тестова', first: 'Анна', middle: null },
					now: new Date()
				}
			)
		);
		const verified = await verifyAttestation(database.db, attestation?.handle ?? '');
		expect(attestationStatementSchema.parse(verified?.statement).judgement).toEqual({
			rubric_by_models_only: true,
			angoff_provisional: true,
			same_vendor_reviewer: false,
			note: judgementNote(view.judgement)
		});
		expect(attestation?.judgementNote).toBe(judgementNote(view.judgement));
		expect(judgementNote({ ...view.judgement, sameVendorReviewer: true })).toBe(
			'Рубрики заданий проверены независимыми моделями, пороги предварительные — их подтверждают эксперты; ' +
				'одна из моделей-рецензентов — того же поставщика, что автор заданий.'
		);
	});

	it('does not confirm a weak candidate and closes the same grade for the retake interval', async () => {
		const standing = new MemoryStanding();
		const subject = await candidateSubject();
		await declareGrade(database.db, candidateIdOf(subject), 'frontend', 'junior');
		sandbox.verdict = () => 'wrong_answer';
		try {
			const { attempt } = await startAttempt(
				database.db,
				deps(standing, 'frontend'),
				subject,
				{ specialization: 'frontend', grade: 'junior' },
				options()
			);
			await takeAttempt(subject, attempt.id, standing, 'frontend', { correct: false });
			const [decision] = await database.db
				.select()
				.from(gradeDecisions)
				.where(eq(gradeDecisions.attemptId, attempt.id));
			// The practice is a gate: failed at its slot, it ends the attempt there, on the three items before it.
			expect(decision).toMatchObject({ outcome: 'not_confirmed', reason: 'practice_gate_failed', items: 3 });
			expect(decision?.practice).toEqual({ score: 0, gateMinScore: 0.4, passed: false });
		} finally {
			sandbox.verdict = () => 'accepted';
		}
		await expect(
			startAttempt(
				database.db,
				deps(standing, 'frontend'),
				subject,
				{ specialization: 'frontend', grade: 'junior' },
				options()
			)
		).rejects.toMatchObject({ code: 'conflict', details: [expect.objectContaining({ code: 'retake_interval' })] });
		// After the interval the retake goes on the other form: the candidate has seen classes of the first one.
		const [first] = await database.db
			.select({ form: testAttempts.form })
			.from(testAttempts)
			.where(and(eq(testAttempts.candidateId, candidateIdOf(subject)), eq(testAttempts.grade, 'junior')));
		const later = { now: new Date(Date.now() + 15 * 86_400_000), requestId: 'retake' };
		const { attempt: retake } = await database.db.transaction((tx) =>
			startAttemptIn(
				tx,
				deps(standing, 'frontend'),
				candidateIdOf(subject),
				{ specialization: 'frontend', grade: 'junior' },
				{
					...later,
					userId: undefined
				}
			)
		);
		expect(retake.form).not.toBe(first?.form);
		await database.db
			.update(testAttempts)
			.set({ status: 'expired', endedAt: later.now })
			.where(eq(testAttempts.id, retake.id));
		// The grade below opens at once after a failure.
		const { attempt: lower } = await startAttempt(
			database.db,
			deps(standing, 'frontend'),
			subject,
			{ specialization: 'frontend', grade: 'intern' },
			options()
		);
		expect(lower.grade).toBe('intern');
	});

	it('folds the step «измени своё решение» into the practice cluster from Middle up', async () => {
		const standing = new MemoryStanding();
		const subject = await candidateSubject();
		await declareGrade(database.db, candidateIdOf(subject), 'backend', 'middle');
		sandbox.verdict = (id) => (id.startsWith('s') ? 'wrong_answer' : 'accepted');
		try {
			const { attempt } = await startAttempt(
				database.db,
				deps(standing, 'backend'),
				subject,
				{ specialization: 'backend', grade: 'middle' },
				options()
			);
			await takeAttempt(subject, attempt.id, standing, 'backend', { correct: true });
			const [practice] = await database.db
				.select()
				.from(testItems)
				.where(and(eq(testItems.attemptId, attempt.id), eq(testItems.practice, true)));
			// The task passed every group, the step none: s = 0.7 · 1 + 0.3 · 0.
			expect(practice?.score).toBe(0.7);
			expect(practice?.scoreDetail).toMatchObject({ task: { score: 1 }, step: { score: 0 } });
			const [decision] = await database.db
				.select()
				.from(gradeDecisions)
				.where(eq(gradeDecisions.attemptId, attempt.id));
			expect(decision?.practice).toEqual({ score: 0.7, gateMinScore: 0.4, passed: true });
		} finally {
			sandbox.verdict = () => 'accepted';
		}
	});

	it('scores QA test cases against the reference and every mutant in two runs', async () => {
		const standing = new MemoryStanding();
		const subject = await candidateSubject();
		await declareGrade(database.db, candidateIdOf(subject), 'qa', 'intern');
		const { attempt } = await startAttempt(
			database.db,
			deps(standing, 'qa'),
			subject,
			{ specialization: 'qa', grade: 'intern' },
			options()
		);
		const before = sandbox.requests.length;
		await takeAttempt(subject, attempt.id, standing, 'qa', { correct: true });
		const harnessRuns = sandbox.requests.slice(before).filter((r) => r.tests[0]?.id === 'harness');
		expect(harnessRuns.map((r) => r.requestId.split(':')[1])).toEqual(['reference', 'mutants']);
		const [practice] = await database.db
			.select()
			.from(testItems)
			.where(and(eq(testItems.attemptId, attempt.id), eq(testItems.practice, true)));
		expect(practice).toMatchObject({
			score: 1,
			scoreDetail: { language: null, task: { kill_ratio: 1, non_equivalent: 5 } }
		});
		// The candidate is never shown the harness output.
		const state = await attemptState(database.db, subject, attempt.id, new Date());
		expect(JSON.stringify(state)).not.toContain('11111');
		// The candidate wrote test cases, not Python: the stack is the defining blocks', no language of the harness.
		const [decision] = await database.db.select().from(gradeDecisions).where(eq(gradeDecisions.attemptId, attempt.id));
		expect(decision?.outcome).toBe('confirmed');
		const category = await categoryOf(candidateIdOf(subject), 'qa');
		const defining = gradeDefinition('qa', 'intern').defining.flatMap((code) => blockDefinition(code).skillKeys);
		expect(category?.confirmedSkillKeys).toEqual([...new Set(defining)].sort());
		expect(category?.confirmedSkillKeys).not.toContain('python');
	});

	it('scores the QA step «измени своё решение» on its changed specification and own mutants', async () => {
		const standing = new MemoryStanding();
		const subject = await candidateSubject();
		await declareGrade(database.db, candidateIdOf(subject), 'qa', 'middle');
		const { attempt } = await startAttempt(
			database.db,
			deps(standing, 'qa'),
			subject,
			{ specialization: 'qa', grade: 'middle' },
			options()
		);
		const before = sandbox.requests.length;
		await takeAttempt(subject, attempt.id, standing, 'qa', { correct: true });
		const steps = sandbox.requests
			.slice(before)
			.filter((r) => r.tests[0]?.id === 'harness' && r.source.includes('min(lo, hi)'));
		expect(steps).toHaveLength(2);
		const [practice] = await database.db
			.select()
			.from(testItems)
			.where(and(eq(testItems.attemptId, attempt.id), eq(testItems.practice, true)));
		expect(practice?.score).toBe(1);
		expect(practice?.scoreDetail).toMatchObject({ task: { score: 1 }, step: { score: 1, non_equivalent: 6 } });
	});

	it('refuses a QA set outside the budget before any run', async () => {
		const standing = new MemoryStanding();
		const subject = await candidateSubject();
		await declareGrade(database.db, candidateIdOf(subject), 'qa', 'intern');
		const { attempt } = await startAttempt(
			database.db,
			deps(standing, 'qa'),
			subject,
			{ specialization: 'qa', grade: 'intern' },
			options()
		);
		// Reach the practice slot.
		for (;;) {
			const state = await attemptState(database.db, subject, attempt.id, new Date());
			const current = state.items.find((i) => i.seq === state.current);
			if (!current) throw new Error('no current item');
			if (current.qa) {
				await expect(
					answerItem(
						database.db,
						deps(standing, 'qa'),
						subject,
						{
							attemptId: attempt.id,
							seq: current.seq,
							payload: { kind: 'cases', cases: STRONG_CASES.slice(0, 4) },
							signals: null
						},
						options()
					)
				).rejects.toMatchObject({
					code: 'policy_violation',
					details: [expect.objectContaining({ code: 'qa_budget_too_small' })]
				});
				return;
			}
			const [row] = await database.db
				.select()
				.from(testItems)
				.where(and(eq(testItems.attemptId, attempt.id), eq(testItems.seq, current.seq)));
			const instance = row?.instance as ItemInstance;
			await answerItem(
				database.db,
				deps(standing, 'qa'),
				subject,
				{
					attemptId: attempt.id,
					seq: current.seq,
					payload: { kind: 'answer', answer: instance.answer?.kind === 'exact' ? instance.answer.value : '' },
					signals: null
				},
				options()
			);
		}
	});
});

describe('a demo session', () => {
	/** A candidate of a live demo session: there the order and the intervals of the grade policy close nothing. */
	async function sessionSubject(): Promise<AccessSubject> {
		const [session] = await database.db
			.insert(demoSessions)
			.values({ joinTokenSha256: randomSha256(), seedBatchId: 'demo-1', expiresAt: new Date(Date.now() + 86_400_000) })
			.returning({ id: demoSessions.id });
		if (!session) throw new Error('demo session not inserted');
		const user = await createUser(database.db, { demoSessionId: session.id });
		const candidate = await createCandidate(database.db, { userId: user.id, demoSessionId: session.id });
		return {
			userId: user.id,
			via: 'session',
			candidate: { id: candidate.id, status: 'active' },
			membership: null,
			staff: { operator: false, admin: false, extraPermissions: [] }
		};
	}

	const start = (subject: AccessSubject, standing: GradeStanding, grade: 'junior' | 'senior') =>
		startAttempt(database.db, deps(standing, 'backend'), subject, { specialization: 'backend', grade }, options());

	it('takes Junior, retakes it at once on the other form, then Senior — the same procedure decides each', async () => {
		const standing = new MemoryStanding();
		const subject = await sessionSubject();
		await declareGrade(database.db, candidateIdOf(subject), 'backend', 'junior');
		const first = await start(subject, standing, 'junior');
		expect(await takeAttempt(subject, first.attempt.id, standing, 'backend', { correct: true })).toMatchObject({
			status: 'decided'
		});
		expect(await categoryOf(candidateIdOf(subject), 'backend')).toMatchObject({ grade: 'junior' });
		// Outside a session the confirmed grade is closed and Senior is two steps above it; here both start at once.
		const retake = await start(subject, standing, 'junior');
		expect(retake.attempt.form).not.toBe(first.attempt.form);
		await takeAttempt(subject, retake.attempt.id, standing, 'backend', { correct: true });
		sandbox.verdict = () => 'wrong_answer';
		try {
			const senior = await start(subject, standing, 'senior');
			await takeAttempt(subject, senior.attempt.id, standing, 'backend', { correct: false });
			const decisions = await database.db
				.select({ grade: gradeDecisions.grade, outcome: gradeDecisions.outcome })
				.from(gradeDecisions)
				.where(eq(gradeDecisions.candidateId, candidateIdOf(subject)))
				.orderBy(asc(gradeDecisions.decidedAt));
			expect(decisions).toEqual([
				{ grade: 'junior', outcome: 'confirmed' },
				{ grade: 'junior', outcome: 'confirmed' },
				{ grade: 'senior', outcome: 'not_confirmed' }
			]);
			// A failure above does not lower the category; the failed Senior is retaken at once as well.
			expect(await categoryOf(candidateIdOf(subject), 'backend')).toMatchObject({ grade: 'junior' });
			expect((await start(subject, standing, 'senior')).attempt.status).toBe('in_progress');
		} finally {
			sandbox.verdict = () => 'accepted';
		}
	});

	it('outside a session the same retake waits for its interval', async () => {
		const standing = new MemoryStanding();
		const subject = await candidateSubject();
		await declareGrade(database.db, candidateIdOf(subject), 'backend', 'junior');
		const first = await start(subject, standing, 'junior');
		await takeAttempt(subject, first.attempt.id, standing, 'backend', { correct: true });
		await expect(start(subject, standing, 'junior')).rejects.toMatchObject({
			status: 409,
			details: [{ code: 'already_confirmed' }]
		});
		await expect(start(subject, standing, 'senior')).rejects.toMatchObject({
			status: 409,
			details: [{ code: 'above_next_grade' }]
		});
	});
});

describe('failures and endings', () => {
	it('never turns a failed sandbox into a verdict: the cluster waits and the attempt is not decided', async () => {
		const standing = new MemoryStanding();
		const subject = await candidateSubject();
		await declareGrade(database.db, candidateIdOf(subject), 'frontend', 'junior');
		const { attempt } = await startAttempt(
			database.db,
			deps(standing, 'frontend'),
			subject,
			{ specialization: 'frontend', grade: 'junior' },
			options()
		);
		sandbox.down = true;
		try {
			for (;;) {
				const state = await attemptState(database.db, subject, attempt.id, new Date());
				const [row] = await database.db
					.select()
					.from(testItems)
					.where(and(eq(testItems.attemptId, attempt.id), eq(testItems.seq, state.current ?? 0)));
				if (!row) throw new Error('no current item');
				const instance = row.instance as ItemInstance;
				if (instance.practice) {
					await answerItem(
						database.db,
						deps(standing, 'frontend'),
						subject,
						{
							attemptId: attempt.id,
							seq: row.seq,
							payload: { kind: 'code', language: 'javascript', source: 'x' },
							signals: null
						},
						options()
					);
					break;
				}
				await answerItem(
					database.db,
					deps(standing, 'frontend'),
					subject,
					{
						attemptId: attempt.id,
						seq: row.seq,
						payload: { kind: 'answer', answer: instance.answer?.kind === 'exact' ? instance.answer.value : '' },
						signals: null
					},
					options()
				);
			}
			const failure = await runTestJob(standing, 'frontend');
			expect(failure).toBeInstanceOf(JobFailure);
			expect(failure).toMatchObject({ code: 'sandbox_unavailable', retryable: true });
			const [practice] = await database.db
				.select()
				.from(testItems)
				.where(and(eq(testItems.attemptId, attempt.id), eq(testItems.practice, true)));
			expect(practice).toMatchObject({ status: 'awaiting_sandbox', score: null });
			// The candidate goes on: the next slot is served while the practice waits.
			const state = await attemptState(database.db, subject, attempt.id, new Date());
			expect(state).toMatchObject({ status: 'in_progress', waitingSandbox: true, current: (practice?.seq ?? 0) + 1 });
		} finally {
			sandbox.down = false;
			// The retry of the failed run waits in the queue; it is not for the tests that follow.
			const submissions = await database.db
				.select({ id: testArtifacts.id })
				.from(testArtifacts)
				.where(and(eq(testArtifacts.attemptId, attempt.id), eq(testArtifacts.kind, 'code_submission')));
			await database.db.transaction(async (tx) => {
				for (const submission of submissions) await cancelWaitingJobs(tx, 'test.run', { artifact_id: submission.id });
			});
		}
	});

	it('expires an attempt past its deadline without a decision', async () => {
		const standing = new MemoryStanding();
		const subject = await candidateSubject();
		await declareGrade(database.db, candidateIdOf(subject), 'frontend', 'junior');
		const { attempt } = await startAttempt(
			database.db,
			deps(standing, 'frontend'),
			subject,
			{ specialization: 'frontend', grade: 'junior' },
			options()
		);
		await expireOverdue(database.db, candidateIdOf(subject), new Date(attempt.deadlineAt.getTime() + 1000));
		const [row] = await database.db.select().from(testAttempts).where(eq(testAttempts.id, attempt.id));
		expect(row?.status).toBe('expired');
		expect(await database.db.select().from(gradeDecisions).where(eq(gradeDecisions.attemptId, attempt.id))).toEqual([]);
	});

	it('annuls a decided attempt: the decision, the fact and the category go back, the reason decides whether it counts', async () => {
		const standing = new MemoryStanding();
		const subject = await candidateSubject();
		const candidateId = candidateIdOf(subject);
		await declareGrade(database.db, candidateId, 'frontend', 'junior');
		const { attempt } = await startAttempt(
			database.db,
			deps(standing, 'frontend'),
			subject,
			{ specialization: 'frontend', grade: 'junior' },
			options()
		);
		await takeAttempt(subject, attempt.id, standing, 'frontend', { correct: true });
		const operator = await createCandidate(database.db);
		const meta = { requestId: 'annul', ip: null, userAgent: null };
		const outcome = await annulAttempt(
			database.db,
			standing,
			operatorSubject(operator.userId),
			meta,
			attempt.id,
			'technical_failure',
			new Date()
		);
		expect(outcome).toEqual({ annulled: true, category: 'revoke' });
		const [decision] = await database.db.select().from(gradeDecisions).where(eq(gradeDecisions.attemptId, attempt.id));
		expect(decision?.status).toBe('annulled');
		expect(await categoryOf(candidateId, 'frontend')).toBeNull();
		expect(
			await annulAttempt(
				database.db,
				standing,
				operatorSubject(operator.userId),
				meta,
				attempt.id,
				'plagiarism',
				new Date()
			)
		).toEqual({ annulled: false, category: 'keep' });
		// A technical failure does not count: the same grade starts again at once.
		const { attempt: retake } = await startAttempt(
			database.db,
			deps(standing, 'frontend'),
			subject,
			{ specialization: 'frontend', grade: 'junior' },
			options()
		);
		expect(retake.status).toBe('in_progress');
		// The decision row is append-only.
		await expect(
			database.sql`update grade_decisions set outcome = 'not_confirmed' where id = ${decision?.id ?? ''}`
		).rejects.toThrow(/append-only/);
	});
});

describe('a seeded attempt', () => {
	it('takes the real path with the deterministic verdict: no sandbox, artifacts marked seeded', async () => {
		const standing = new MemoryStanding();
		const subject = await candidateSubject();
		const candidateId = candidateIdOf(subject);
		await declareGrade(database.db, candidateId, 'backend', 'middle');
		const requests = sandbox.requests.length;
		const run = () =>
			database.db.transaction((tx) =>
				runSeededAttempt(tx, deps(standing, 'backend'), {
					candidateId,
					specialization: 'backend',
					grade: 'middle',
					trueShare: 0.97,
					candidateSeed: 'hero-1',
					attemptSeed: '5eed'.repeat(8),
					now: new Date(),
					requestId: 'seed'
				})
			);
		const { attemptId, outcome } = await run();
		expect(outcome.kind).toBe('decided');
		expect(sandbox.requests.length).toBe(requests);
		const [attempt] = await database.db.select().from(testAttempts).where(eq(testAttempts.id, attemptId));
		expect(attempt).toMatchObject({ seeded: true, status: 'decided' });
		const [decision] = await database.db.select().from(gradeDecisions).where(eq(gradeDecisions.attemptId, attemptId));
		expect(decision?.outcome).toBe('confirmed');
		const artifacts = await database.db
			.select({ content: testArtifacts.content })
			.from(testArtifacts)
			.where(eq(testArtifacts.attemptId, attemptId))
			.orderBy(asc(testArtifacts.seq));
		expect(artifacts.every((a) => (a.content as { seeded?: boolean }).seeded === true)).toBe(true);
	});
});

describe('the release of the bank', () => {
	it('releases a bank that passes, keeps the same content, replaces a changed one or changed shared code, refuses one that runs out', async () => {
		const client = postgres(database.url, { max: 1, onnotice: () => {} });
		const dir = await mkdtemp(join(tmpdir(), 'trajectories-'));
		// The start never simulates; the check and `db:release-bank` simulate what is missing and store it.
		const atStart = fileTrajectoryStore(dir, false);
		const simulating = fileTrajectoryStore(dir, true);
		const bank = (families: ReturnType<typeof fixtureFamilies>, sharedSha256 = '0'.repeat(64)) =>
			new Map([['data_ml' as const, { ok: true as const, bank: { families, sharedSha256 } }]]);
		try {
			const families = fixtureFamilies('data_ml');
			expect(await publishBankReleases(client, bank(families), atStart)).toEqual([
				{ specialization: 'data_ml', outcome: 'unchecked', id: null, problems: [], withdrawn: null }
			]);
			expect(await checkBankTree(bank(families), simulating)).toMatchObject([{ outcome: 'unchanged', problems: [] }]);
			const stored = JSON.parse(await readFile(join(dir, 'data_ml.json'), 'utf8')) as {
				report: { grades: unknown };
			};

			const first = await publishBankReleases(client, bank(families), atStart);
			expect(first).toMatchObject([{ specialization: 'data_ml', outcome: 'released', id: `data_ml@${V}-1` }]);
			const [released] = await database.db
				.select({ manifest: bankReleases.manifest })
				.from(bankReleases)
				.where(eq(bankReleases.id, `data_ml@${V}-1`));
			// The stored report, under the id of this release.
			expect((released?.manifest as { trajectories: unknown }).trajectories).toMatchObject({
				releaseId: `data_ml@${V}-1`,
				grades: stored.report.grades
			});
			expect(await publishBankReleases(client, bank(families), atStart)).toMatchObject([
				{ outcome: 'unchanged', id: `data_ml@${V}-1` }
			]);
			const changed = families.map((f, i) => (i === 0 ? { ...f, generatorSha256: 'f'.repeat(64) } : f));
			expect(await publishBankReleases(client, bank(changed), atStart)).toMatchObject([{ outcome: 'unchecked' }]);
			expect(await publishBankReleases(client, bank(changed), simulating)).toMatchObject([
				{ outcome: 'released', id: `data_ml@${V}-2` }
			]);
			expect(await publishBankReleases(client, bank(changed, 'e'.repeat(64)), simulating)).toMatchObject([
				{ outcome: 'released', id: `data_ml@${V}-3` }
			]);
			const releases = await database.db
				.select({ id: bankReleases.id, status: bankReleases.status, shared: bankReleases.sharedSha256 })
				.from(bankReleases)
				.where(eq(bankReleases.specialization, 'data_ml'))
				.orderBy(desc(bankReleases.id));
			expect(releases.map((r) => [r.id, r.status])).toEqual([
				[`data_ml@${V}-3`, 'released'],
				[`data_ml@${V}-2`, 'retired'],
				[`data_ml@${V}-1`, 'retired']
			]);
			expect(releases[0]?.shared).toBe('e'.repeat(64));
			const lacking = families.filter((f) => f.descriptor.key !== 'ds.stats.intern-0');
			const [refused] = await publishBankReleases(client, bank(lacking), simulating);
			expect(refused?.outcome).toBe('refused');
			expect(
				refused?.problems.some((p) => p.code === 'defect' && /intern .* runs out: .*ds\.stats/.test(p.message))
			).toBe(true);
		} finally {
			await client.end({ timeout: 5 });
			await rm(dir, { recursive: true, force: true });
		}
	}, 180_000);
});

describe('objections through the owner of objections and the engine', () => {
	async function confirmed(standing: MemoryStanding) {
		const subject = await candidateSubject();
		const candidateId = candidateIdOf(subject);
		await declareGrade(database.db, candidateId, 'frontend', 'junior');
		const { attempt } = await startAttempt(
			database.db,
			deps(standing, 'frontend'),
			subject,
			{ specialization: 'frontend', grade: 'junior' },
			options()
		);
		await takeAttempt(subject, attempt.id, standing, 'frontend', { correct: true });
		const [decision] = await database.db.select().from(gradeDecisions).where(eq(gradeDecisions.attemptId, attempt.id));
		if (!decision || !subject.userId) throw new Error('no decision');
		const objection = await openObjection(database.db, OBJECTION_DECISIONS, {
			candidateId,
			userId: subject.userId,
			decisionId: decision.id,
			reason: 'Ответ совпадал с ключом, балл не засчитан',
			requestId: 'objection',
			now: new Date()
		});
		const operator = await createCandidate(database.db);
		await assignObjection(database.db, {
			objectionId: objection.id,
			operatorId: operator.userId,
			requestId: 'objection'
		});
		return { candidateId, attempt, decision, objection, operatorId: operator.userId };
	}

	it('holds the artifacts of the attempt until the answer is due plus 30 days, and the sweep keeps them', async () => {
		const standing = new MemoryStanding();
		const { attempt, objection } = await confirmed(standing);
		const held = new Date(objection.dueAt.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
		const rows = await database.db
			.select({ until: testArtifacts.retentionUntil })
			.from(testArtifacts)
			.where(eq(testArtifacts.attemptId, attempt.id));
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((r) => r.until >= held)).toBe(true);
		const found = await OBJECTION_DECISIONS.find(database.db, objection.decisionId);
		expect(found?.artifactsKeptUntil.toISOString().slice(0, 10)).toBe(held);
		// Even past every date, the sweep leaves the artifacts of an attempt under an open objection.
		await database.db.transaction((tx) => clearExpiredArtifacts(tx, '2999-01-01', new Set()));
		const after = await database.db
			.select({ content: testArtifacts.content })
			.from(testArtifacts)
			.where(eq(testArtifacts.attemptId, attempt.id));
		expect(after.every((a) => a.content !== null)).toBe(true);
		// The table lets `retention_until` move later only.
		await expect(
			database.sql`update test_artifacts set retention_until = '2020-01-01' where attempt_id = ${attempt.id}`
		).rejects.toThrow(/append-only/);
	});

	it('rescores: the procedure replays the clusters as served, the new decision supersedes the old one', async () => {
		const standing = new MemoryStanding();
		const { candidateId, decision, objection, operatorId } = await confirmed(standing);
		const items = await database.db
			.select()
			.from(testItems)
			.where(and(eq(testItems.attemptId, decision.attemptId), eq(testItems.practice, false)))
			.orderBy(asc(testItems.seq));
		const corrected = items.slice(0, 4);
		// Four items of the defining blocks re-scored to 0: the replay rejects instead of confirming.
		const resolved = await resolveObjection(database.db, OBJECTION_DECISIONS, {
			objectionId: objection.id,
			operatorId,
			answer: {
				outcome: 'rescored',
				resolution: 'Ответы сверены с ключами сохранённых экземпляров',
				items: corrected.map((c) => ({ seq: c.seq, score: 0, reason: 'ответ не совпадает с ключом' }))
			},
			requestId: 'objection'
		});
		const rows = await database.db
			.select()
			.from(gradeDecisions)
			.where(eq(gradeDecisions.attemptId, decision.attemptId))
			.orderBy(asc(gradeDecisions.decidedAt));
		expect(rows.map((r) => r.status).sort()).toEqual(['superseded', 'valid']);
		const next = rows.find((r) => r.status === 'valid');
		expect(next).toMatchObject({ id: resolved.resultingDecisionId, supersedesDecisionId: decision.id });
		expect(next?.outcome).not.toBe('confirmed');
		expect(await categoryOf(candidateId, 'frontend')).toBeNull();
		const [reviewed] = await database.db
			.select()
			.from(testItems)
			.where(and(eq(testItems.attemptId, decision.attemptId), eq(testItems.seq, corrected[0]?.seq ?? 0)));
		expect(reviewed).toMatchObject({ score: 0, scoreDetail: { reviews: [{ previous: 1, score: 0 }] } });
		// A superseded decision is not changed again; a score off the scale is refused.
		const objected = await OBJECTION_DECISIONS.find(database.db, decision.id);
		if (!objected) throw new Error('no decision');
		const journal = { requestId: 'objection', actor: { kind: 'system' as const } };
		await expect(
			database.db.transaction((tx) => OBJECTION_DECISIONS.rescore(tx, objected, [], journal))
		).rejects.toMatchObject({ code: 'conflict' });
		const current = await OBJECTION_DECISIONS.find(database.db, resolved.resultingDecisionId ?? '');
		if (!current) throw new Error('no new decision');
		await expect(
			database.db.transaction((tx) =>
				OBJECTION_DECISIONS.rescore(tx, current, [{ seq: corrected[0]?.seq ?? 0, score: 0.33, reason: 'x' }], journal)
			)
		).rejects.toMatchObject({ code: 'validation_failed' });
	});

	it('annuls with objection_upheld: not counted, the category follows the remaining decisions', async () => {
		const standing = new MemoryStanding();
		const { candidateId, decision, objection, operatorId } = await confirmed(standing);
		await resolveObjection(database.db, OBJECTION_DECISIONS, {
			objectionId: objection.id,
			operatorId,
			answer: { outcome: 'annulled', resolution: 'Попытка не засчитывается, тест можно пройти снова' },
			requestId: 'objection'
		});
		const [attempt] = await database.db.select().from(testAttempts).where(eq(testAttempts.id, decision.attemptId));
		expect(attempt).toMatchObject({ status: 'annulled', annulReason: 'objection_upheld' });
		expect(await categoryOf(candidateId, 'frontend')).toBeNull();
		const [revoked] = await database.db
			.select()
			.from(candidateCategories)
			.where(eq(candidateCategories.decisionId, decision.id));
		expect(revoked).toMatchObject({ status: 'revoked', revokeReason: 'objection_annulled' });
	});

	it('refuses to annul a running attempt for anything but a stuck sandbox', async () => {
		const standing = new MemoryStanding();
		const subject = await candidateSubject();
		await declareGrade(database.db, candidateIdOf(subject), 'frontend', 'junior');
		const { attempt } = await startAttempt(
			database.db,
			deps(standing, 'frontend'),
			subject,
			{ specialization: 'frontend', grade: 'junior' },
			options()
		);
		const operator = await createCandidate(database.db);
		const meta = { requestId: 'annul', ip: null, userAgent: null };
		for (const reason of ['plagiarism', 'technical_failure'] as const) {
			await expect(
				annulAttempt(database.db, standing, operatorSubject(operator.userId), meta, attempt.id, reason, new Date())
			).rejects.toMatchObject({ code: 'conflict' });
		}
	});
});
