// The engine of the test on a declared grade (docs/domain.md, 10.4–10.7): an attempt starts when the grade policy lets
// it, slots are served one by one from the release the attempt started on in the order of the plan (the defining blocks
// first, the practice at its slot), every scored cluster goes to the one procedure of the contract, and its decision is
// written in one transaction with the attempt and the call to the owner of the category (`applyGradeDecisions`), who
// brings the category and the fact of the test to all the decisions. A program and QA test cases are scored by the
// sandbox job (`run-job.ts`): the cluster waits as `awaiting_sandbox`, the candidate goes on, and the procedure reads only
// the prefix of scored clusters — the decision is taken at the first length where it is final (a practice under the gate
// ends the attempt there), clusters served after that length do not count.
//
// The answers are the candidate's data: an attempt starts and takes answers only with `pd_processing` in effect.
import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, lte, max, ne, sql } from 'drizzle-orm';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import { requireProcessingConsent } from '$lib/server/consent/processing';
import type { Database, Executor, Transaction } from '$lib/server/db';
import {
	candidates,
	confirmationRequests,
	gradeDecisions,
	testArtifacts,
	testAttempts,
	testItems
} from '$lib/server/db/schema';
import { ApiError, policyViolation } from '$lib/server/errors/api-error';
import { uuidv7 } from '$lib/server/ids';
import type { JobCreator } from '$lib/server/jobs/queue';
import { enqueueJob } from '$lib/server/jobs/queue';
import { canonicalJson } from '$lib/server/json/canonical';
import { codeSubmissionArtifact } from '$lib/server/sandbox/artifacts';
import { MAX_SOURCE_BYTES } from '$lib/server/sandbox/request';
import { familyModule, releaseById, releaseInForce, type ModuleSource, type ServedRelease } from './bank-store';
import {
	blockTestAllowed,
	blockTestDurationMs,
	blockTestInWindow,
	blockTestServable,
	blockTestSlots,
	recordBlockResult
} from './block-test';
import type { FamilyDescriptor, ItemInstance } from './contract/bank';
import { CATALOG, GRADE_KEYS, gradeDefinition, type GradeKey, type SpecializationKey } from './contract/catalog';
import { GRADE_POLICY } from './contract/policy';
import {
	PROCEDURE,
	exhaustedDecision,
	maxLength,
	nextStep,
	type ClusterResult,
	type GradeDecision
} from './contract/procedure';
import { sha256Hex } from './families';
import { assessmentPolicy, retentionUntil } from './policy';
import { answerMatches, type CandidateAnswer, type QaCase } from './score';
import { attemptDurationMs, attemptForm, chooseForSlot, seenKey, slotsOf, type AttemptForm } from './select';
import { FOREIGN_COMPARED, foreignInstance } from './leak';
import { servingFamilies } from './quarantine';
import { appendSignal, type ClientSignals, type SignalEntry } from './signals';
import { admitGradeTest } from '$lib/server/grades/policy';
import { gradeSources } from '$lib/server/grades/sources';
import type { GradeStanding } from './standing';

export type AttemptRow = typeof testAttempts.$inferSelect;
export type ItemRow = typeof testItems.$inferSelect;

export interface EngineDeps {
	standing: GradeStanding;
	/** Generators of the families of a release; the bank tree by default. */
	modules?: ModuleSource;
}

/** The candidate acting on their own tests; anyone else — even an operator — is refused here. */
export function ownCandidateId(subject: AccessSubject, mode: 'read' | 'write'): string {
	const candidateId = subject.candidate?.id;
	if (candidateId === undefined) throw new ApiError(subject.userId === null ? 'unauthenticated' : 'forbidden');
	const access = can(subject, mode === 'read' ? 'candidate.self.read' : 'candidate.self.write', { candidateId });
	if (!access.allowed) throw new ApiError(access.reason === 'unauthenticated' ? 'unauthenticated' : 'forbidden');
	return candidateId;
}

function conflict(code: string, message: string, extra: { available_from?: string } = {}): ApiError {
	const detail = extra.available_from ? `${message} (с ${extra.available_from})` : message;
	return new ApiError('conflict', { message, details: [{ code, message: detail }] });
}

function invalidField(path: string, message: string): ApiError {
	return new ApiError('validation_failed', { message, details: [{ path, code: 'invalid', message }] });
}

const isGrade = (value: string): value is GradeKey => (GRADE_KEYS as readonly string[]).includes(value);

export function gradeOf(attempt: { grade: string }): GradeKey {
	if (!isGrade(attempt.grade)) throw new Error(`attempt of unknown grade ${attempt.grade}`);
	return attempt.grade;
}

// --- Expiry -----------------------------------------------------------------------------------------------------

/**
 * `in_progress → expired` for the candidate's attempts past their deadline whose next move is the candidate's: an
 * attempt waiting only for the sandbox is not expired — the sandbox's delay is not the candidate's.
 */
export async function expireOverdue(executor: Executor, candidateId: string, now: Date): Promise<void> {
	await executor
		.update(testAttempts)
		.set({ status: 'expired', endedAt: now })
		.where(
			and(
				eq(testAttempts.candidateId, candidateId),
				eq(testAttempts.status, 'in_progress'),
				lte(testAttempts.deadlineAt, now),
				sql`not exists (select 1 from ${testItems} where ${testItems.attemptId} = ${testAttempts.id} and ${testItems.status} = 'awaiting_sandbox')`
			)
		);
}

// --- Artifacts --------------------------------------------------------------------------------------------------

export interface ArtifactDraft {
	id?: string;
	kind: (typeof testArtifacts.$inferInsert)['kind'];
	content: Record<string, unknown>;
}

/** Appends artifacts after the last one of the attempt (the attempt row is locked by the caller). */
export async function appendArtifacts(
	tx: Transaction,
	attemptId: string,
	itemId: string,
	drafts: readonly ArtifactDraft[],
	at: Date
): Promise<string[]> {
	if (drafts.length === 0) return [];
	const [last] = await tx
		.select({ seq: max(testArtifacts.seq) })
		.from(testArtifacts)
		.where(eq(testArtifacts.attemptId, attemptId));
	const until = retentionUntil(await assessmentPolicy(tx, at), at);
	const start = (last?.seq ?? 0) + 1;
	const rows = await tx
		.insert(testArtifacts)
		.values(
			drafts.map((draft, index) => ({
				...(draft.id === undefined ? {} : { id: draft.id }),
				attemptId,
				itemId,
				seq: start + index,
				kind: draft.kind,
				content: draft.content,
				sha256: sha256Hex(canonicalJson(draft.content)),
				createdAt: at,
				retentionUntil: until
			}))
		)
		.returning({ id: testArtifacts.id });
	return rows.map((row) => row.id);
}

// --- Serving and deciding ---------------------------------------------------------------------------------------

/**
 * `seenKey`s of every class served to the candidate within the window of forms — counted from the start of the attempt
 * that served it (domain 10.4) — free annulments aside.
 */
export async function seenClasses(executor: Executor, candidateId: string, now: Date): Promise<Set<string>> {
	const since = new Date(now.getTime() - GRADE_POLICY.formWindowDays * 86_400_000);
	const rows = await executor
		.select({
			family: testItems.familyKey,
			grade: testAttempts.grade,
			classId: testItems.classId,
			status: testAttempts.status,
			reason: testAttempts.annulReason
		})
		.from(testItems)
		.innerJoin(testAttempts, eq(testAttempts.id, testItems.attemptId))
		.where(and(eq(testAttempts.candidateId, candidateId), gt(testAttempts.startedAt, since)));
	const free = GRADE_POLICY.freeRetakeAnnulReasons;
	return new Set(
		rows
			.filter((r) => !(r.status === 'annulled' && r.reason !== null && free.includes(r.reason)))
			.map((r) => seenKey(r.family, gradeOf(r), r.classId))
	);
}

/**
 * The form of the candidate's latest grade attempt at the specialization and grade within the window of forms, free
 * annulments aside — the form a retake does not take again (domain 10.4); `null` — no such attempt.
 */
export async function previousForm(
	executor: Executor,
	candidateId: string,
	specialization: SpecializationKey,
	grade: GradeKey,
	now: Date
): Promise<AttemptForm | null> {
	const since = new Date(now.getTime() - GRADE_POLICY.formWindowDays * 86_400_000);
	const rows = await executor
		.select({ form: testAttempts.form, status: testAttempts.status, reason: testAttempts.annulReason })
		.from(testAttempts)
		.where(
			and(
				eq(testAttempts.candidateId, candidateId),
				eq(testAttempts.purpose, 'grade'),
				eq(testAttempts.specialization, specialization),
				eq(testAttempts.grade, grade),
				gt(testAttempts.startedAt, since)
			)
		)
		.orderBy(desc(testAttempts.startedAt));
	const free = GRADE_POLICY.freeRetakeAnnulReasons;
	const latest = rows.find((r) => !(r.status === 'annulled' && r.reason !== null && free.includes(r.reason)));
	if (latest === undefined) return null;
	if (latest.form === null) throw new Error(`a grade attempt of candidate ${candidateId} has no form`);
	return latest.form;
}

const clusterOf = (item: ItemRow): ClusterResult => {
	if (item.score === null) throw new Error(`item ${item.id} is not scored`);
	return { block: item.block, angoff: item.angoff, score: item.score, practice: item.practice };
};

/** A cluster with the step «измени своё решение» whose task is not scored yet. */
const stepPending = (item: ItemRow): boolean =>
	(item.instance as ItemInstance).changeStep !== null &&
	(item.scoreDetail as { task?: unknown } | null)?.task === undefined;

/** The rule of the procedure for an attempt: its grade definition. */
export const ruleOf = (attempt: { specialization: string; grade: string }) =>
	gradeDefinition(attempt.specialization as SpecializationKey, gradeOf(attempt));

/** The decision row of the contract's `GradeDecision` for an attempt. */
export function decisionValues(attempt: AttemptRow, decision: GradeDecision, now: Date) {
	return {
		attemptId: attempt.id,
		candidateId: attempt.candidateId,
		specialization: attempt.specialization,
		grade: decision.grade,
		outcome: decision.outcome,
		reason: decision.reason,
		confident: decision.confident,
		llr: decision.llr,
		scoreSum: decision.scoreSum,
		cutSum: decision.cutSum,
		items: decision.items,
		extensionUsed: decision.extensionUsed,
		practice: decision.practice,
		blocks: decision.blocks,
		procedureVersion: decision.procedureVersion,
		bankReleaseId: attempt.bankReleaseId,
		status: 'valid' as const,
		decidedAt: now
	};
}

/**
 * Writes a decision: the decision row and the attempt `decided`, then the owner of the category brings the category and
 * the fact of the test to all the decisions of the specialization (domain 10.9, 12.4).
 */
async function writeDecision(
	tx: Transaction,
	deps: EngineDeps,
	attempt: AttemptRow,
	decision: GradeDecision,
	context: { now: Date; requestId: string; createdBy: JobCreator }
): Promise<string> {
	const { now } = context;
	const [row] = await tx
		.insert(gradeDecisions)
		.values(decisionValues(attempt, decision, now))
		.returning({ id: gradeDecisions.id });
	if (!row) throw new Error('decision was not inserted');
	await tx.update(testAttempts).set({ status: 'decided', endedAt: now }).where(eq(testAttempts.id, attempt.id));
	await deps.standing.applyGradeDecisions(tx, attempt.candidateId, attempt.specialization as SpecializationKey, {
		requestId: context.requestId,
		actor:
			context.createdBy.kind === 'user' && context.createdBy.id
				? { kind: 'user', userId: context.createdBy.id }
				: { kind: 'system' }
	});
	return row.id;
}

/**
 * Serves slot `seq` of the plan — of the grade, or of the block test (`slot` given): the family-level by the rule of
 * 10.4 among the families not in a quarantine begun by the attempt's start (10.5), the instance generated and stored.
 * `null` — nothing eligible.
 */
async function serveSlot(
	tx: Transaction,
	deps: EngineDeps,
	attempt: AttemptRow,
	release: ServedRelease,
	usedFamilies: ReadonlySet<string>,
	seq: number,
	now: Date,
	blockSlot?: { block: string; practice: false }
): Promise<ItemRow | null> {
	const grade = gradeOf(attempt);
	const slot = blockSlot ?? slotsOf(release.specialization, grade)[seq - 1];
	if (!slot) throw new Error(`no slot ${seq} of ${release.specialization} ${grade}`);
	const choice = chooseForSlot({
		families: (await servingFamilies(tx, release, attempt.startedAt)).map((f) => f.descriptor),
		grade,
		slot,
		want: attempt.form === null ? { kind: 'reserve' } : { kind: 'grade', form: attempt.form },
		usedFamilies,
		seen: await seenClasses(tx, attempt.candidateId, now),
		attemptSeed: attempt.seed,
		seq
	});
	if (!choice) return null;
	const family = release.families.find((f) => f.descriptor.key === choice.family.key);
	if (!family) throw new Error(`family ${choice.family.key} is not in ${release.id}`);
	const module = await (deps.modules ?? familyModule)(family, release);
	const instance = module.generate({ seed: choice.seed, grade, classId: choice.classId });
	const [item] = await tx
		.insert(testItems)
		.values({
			attemptId: attempt.id,
			seq,
			block: slot.block,
			format: choice.family.format,
			practice: slot.practice,
			familyKey: choice.family.key,
			familyVersion: choice.family.version,
			classId: choice.classId,
			instanceSeed: choice.seed,
			instance,
			angoff: choice.level.angoff.mean,
			servedAt: now,
			status: 'served'
		})
		.returning();
	if (!item) throw new Error('item was not inserted');
	return item;
}

export type AdvanceOutcome =
	| { kind: 'next'; item: ItemRow }
	/** The candidate's move: the current item is not answered yet, or its step «измени своё решение» is open. */
	| { kind: 'waiting_candidate'; item: ItemRow }
	/** Every served item is answered and the procedure needs a cluster the sandbox is still scoring. */
	| { kind: 'waiting_sandbox' }
	| { kind: 'decided'; decisionId: string }
	/** The four clusters of a block test are scored: its result (`block_confirmations`), never a grade decision. */
	| { kind: 'block_decided'; confirmationId: string }
	| { kind: 'expired' };

/**
 * Moves the attempt as far as it goes: the procedure over the prefix of scored clusters, a decision at the first length
 * where it is final, otherwise the next slot when the candidate's move is done. The attempt row is locked by the caller.
 */
export async function advance(
	tx: Transaction,
	deps: EngineDeps,
	attempt: AttemptRow,
	context: { now: Date; requestId: string; createdBy: JobCreator }
): Promise<AdvanceOutcome> {
	const { now } = context;
	const items = await tx
		.select()
		.from(testItems)
		.where(eq(testItems.attemptId, attempt.id))
		.orderBy(asc(testItems.seq));
	if (attempt.purpose === 'vacancy_block') return advanceBlockTest(tx, deps, attempt, items, context);
	const grade = gradeOf(attempt);
	const rule = ruleOf(attempt);
	const prefix: ClusterResult[] = [];
	for (const item of items) {
		if (item.status !== 'scored') break;
		prefix.push(clusterOf(item));
		const step = nextStep(PROCEDURE, rule, prefix);
		if (step.kind === 'decided') {
			return { kind: 'decided', decisionId: await writeDecision(tx, deps, attempt, step.decision, context) };
		}
	}
	const open = items.find((i) => i.status === 'served' || i.status === 'answered');
	if (open) {
		if (attempt.deadlineAt <= now) return expire(tx, attempt, now);
		return { kind: 'waiting_candidate', item: open };
	}
	// The step «измени своё решение» follows its task: nothing else is served until the task is scored and the step
	// answered, so the candidate is never sent back to an earlier cluster.
	if (items.some((i) => i.status === 'awaiting_sandbox' && stepPending(i))) return { kind: 'waiting_sandbox' };
	const allScored = items.every((i) => i.status === 'scored');
	if (items.length >= maxLength(PROCEDURE, grade)) {
		if (allScored) throw new Error(`attempt ${attempt.id}: the procedure did not decide on the longest trajectory`);
		return { kind: 'waiting_sandbox' };
	}
	if (attempt.deadlineAt <= now) {
		if (allScored) return expire(tx, attempt, now);
		return { kind: 'waiting_sandbox' };
	}
	const release = await releaseById(tx, attempt.bankReleaseId);
	const item = await serveSlot(
		tx,
		deps,
		attempt,
		release,
		new Set(items.map((i) => i.familyKey)),
		items.length + 1,
		now
	);
	if (item) return { kind: 'next', item };
	if (!allScored) return { kind: 'waiting_sandbox' };
	const decision = exhaustedDecision(PROCEDURE, rule, items.map(clusterOf));
	return { kind: 'decided', decisionId: await writeDecision(tx, deps, attempt, decision, context) };
}

/**
 * A block test (domain 13.11) moves on clusters of its block only: the next one when the candidate answered the current
 * one, the result when all four are scored. Its clusters have no practice, so nothing waits for the sandbox.
 */
async function advanceBlockTest(
	tx: Transaction,
	deps: EngineDeps,
	attempt: AttemptRow,
	items: readonly ItemRow[],
	context: { now: Date; requestId: string }
): Promise<AdvanceOutcome> {
	const { now } = context;
	const slots = blockTestSlots(await requestBlockOf(tx, attempt));
	if (items.length === slots.length && items.every((item) => item.status === 'scored')) {
		return { kind: 'block_decided', confirmationId: await recordBlockResult(tx, attempt, context) };
	}
	if (attempt.deadlineAt <= now) return expire(tx, attempt, now);
	const open = items.find((i) => i.status !== 'scored');
	if (open) return { kind: 'waiting_candidate', item: open };
	const slot = slots[items.length];
	if (!slot) throw new Error(`block test ${attempt.id} has more clusters than its plan`);
	const release = await releaseById(tx, attempt.bankReleaseId);
	const item = await serveSlot(
		tx,
		deps,
		attempt,
		release,
		new Set(items.map((i) => i.familyKey)),
		items.length + 1,
		now,
		slot
	);
	// The whole block test was checked servable when it started; the families it used are its own.
	if (!item) throw new Error(`block test ${attempt.id}: the release ran out of the block it was checked to serve`);
	return { kind: 'next', item };
}

async function requestBlockOf(tx: Transaction, attempt: AttemptRow): Promise<string> {
	if (attempt.confirmationRequestId === null) throw new Error(`block test ${attempt.id} names no request`);
	const [request] = await tx
		.select({ block: confirmationRequests.block })
		.from(confirmationRequests)
		.where(eq(confirmationRequests.id, attempt.confirmationRequestId));
	if (!request) throw new Error(`request of block test ${attempt.id} is missing`);
	return request.block;
}

async function expire(tx: Transaction, attempt: AttemptRow, now: Date): Promise<AdvanceOutcome> {
	await tx.update(testAttempts).set({ status: 'expired', endedAt: now }).where(eq(testAttempts.id, attempt.id));
	return { kind: 'expired' };
}

// --- Starting ---------------------------------------------------------------------------------------------------

async function lockCandidateRow(tx: Transaction, candidateId: string): Promise<void> {
	const [row] = await tx
		.select({ id: candidates.id })
		.from(candidates)
		.where(eq(candidates.id, candidateId))
		.for('update');
	if (!row) throw new ApiError('not_found');
}

export interface StartInput {
	specialization: SpecializationKey;
	grade: GradeKey;
}

export interface StartOptions {
	now: Date;
	requestId: string;
	userId: string | undefined;
	/** A seeded attempt of the demo (domain 23.3). */
	seeded?: boolean;
	/**
	 * The seed of a seeded attempt, given by the demo seed so that it can foresee the attempt's trajectory; any other
	 * attempt draws its own.
	 */
	attemptSeed?: string;
}

/**
 * Starts a `grade` attempt in a transaction the caller owns (the candidate row is locked, so two clicks cannot open two
 * attempts): the specialization must be open, the grade policy must let the grade start, the form follows the previous
 * attempt at the grade (`attemptForm`), the first slot is served.
 */
export async function startAttemptIn(
	tx: Transaction,
	deps: EngineDeps,
	candidateId: string,
	input: StartInput,
	options: StartOptions
): Promise<{ attempt: AttemptRow; outcome: AdvanceOutcome }> {
	const { now } = options;
	await lockCandidateRow(tx, candidateId);
	await requireProcessingConsent(tx, candidateId, now);
	await expireOverdue(tx, candidateId, now);
	// The policy of the grade decides, in this transaction, on the attempts it reads (domain 12.3).
	const { kind } = await admitGradeTest(tx, gradeSources, {
		candidateId,
		specialization: input.specialization,
		grade: input.grade,
		now
	});
	const release = await releaseInForce(tx, input.specialization);
	if (!release) throw new Error(`specialization ${input.specialization} is open without a release in force`);
	if (options.attemptSeed !== undefined && options.seeded !== true) {
		throw new Error('only a seeded attempt is started with a given seed');
	}
	const seed = options.attemptSeed ?? randomBytes(16).toString('hex');
	const families = (await servingFamilies(tx, release, now)).map((f) => f.descriptor);
	const form: AttemptForm = attemptForm(
		families,
		input.grade,
		await seenClasses(tx, candidateId, now),
		await previousForm(tx, candidateId, input.specialization, input.grade, now),
		seed
	);
	const [attempt] = await tx
		.insert(testAttempts)
		.values({
			candidateId,
			purpose: 'grade',
			specialization: input.specialization,
			grade: input.grade,
			catalogVersion: CATALOG.version,
			bankReleaseId: release.id,
			procedureVersion: PROCEDURE.version,
			policyVersion: GRADE_POLICY.version,
			form,
			viaConfidentUpgrade: kind === 'upgrade_confident',
			seed,
			status: 'in_progress',
			startedAt: now,
			deadlineAt: new Date(now.getTime() + attemptDurationMs(families, input.specialization, input.grade)),
			seeded: options.seeded ?? false
		})
		.returning();
	if (!attempt) throw new Error('attempt was not inserted');
	const outcome = await advance(tx, deps, attempt, {
		now,
		requestId: options.requestId,
		createdBy: { kind: 'user', id: options.userId }
	});
	return { attempt, outcome };
}

/** What a block test starts from: the accepted request of the employer (domain 13.11). */
export interface BlockTestInput {
	requestId: string;
	specialization: SpecializationKey;
	block: string;
	grade: GradeKey;
}

/**
 * Starts the block test of an accepted request in the caller's transaction: the candidate row is locked (one attempt
 * in progress), the pair must have a block test, one block test of the pair within the window of forms, the release
 * in force must serve all four clusters to this candidate (`409 bank_capacity_exhausted` otherwise), the first cluster
 * is served. The grade policy does not apply: a block test decides no grade.
 */
export async function startBlockAttemptIn(
	tx: Transaction,
	deps: EngineDeps,
	candidateId: string,
	input: BlockTestInput,
	options: StartOptions
): Promise<{ attempt: AttemptRow; outcome: AdvanceOutcome }> {
	const { now } = options;
	await lockCandidateRow(tx, candidateId);
	await requireProcessingConsent(tx, candidateId, now);
	await expireOverdue(tx, candidateId, now);
	if (!blockTestAllowed(input.specialization, input.block, input.grade)) {
		throw policyViolation('block_not_testable', 'block');
	}
	const [running] = await tx
		.select({ id: testAttempts.id })
		.from(testAttempts)
		.where(and(eq(testAttempts.candidateId, candidateId), eq(testAttempts.status, 'in_progress')));
	if (running) throw conflict('attempt_in_progress', 'Сначала завершите начатую попытку теста');
	const earlier = await blockTestInWindow(tx, candidateId, input, now);
	if (earlier !== null) {
		const from = new Date(earlier.getTime() + GRADE_POLICY.formWindowDays * 86_400_000);
		throw conflict('block_test_window', 'Блок-тест этого блока на этом грейде уже проходился', {
			available_from: from.toISOString().slice(0, 10)
		});
	}
	const release = await releaseInForce(tx, input.specialization);
	if (!release) throw policyViolation('specialization_closed', 'block');
	const families = (await servingFamilies(tx, release, now)).map((f) => f.descriptor);
	const seed = randomBytes(16).toString('hex');
	if (!blockTestServable(families, input.grade, input.block, await seenClasses(tx, candidateId, now), seed)) {
		throw conflict('bank_capacity_exhausted', 'Для этого блока сейчас нет свободных заданий: попробуйте позже');
	}
	const [attempt] = await tx
		.insert(testAttempts)
		.values({
			candidateId,
			purpose: 'vacancy_block',
			specialization: input.specialization,
			grade: input.grade,
			catalogVersion: CATALOG.version,
			bankReleaseId: release.id,
			procedureVersion: PROCEDURE.version,
			policyVersion: GRADE_POLICY.version,
			form: null,
			seed,
			status: 'in_progress',
			startedAt: now,
			deadlineAt: new Date(now.getTime() + blockTestDurationMs(families, input.grade, input.block)),
			confirmationRequestId: input.requestId,
			seeded: options.seeded ?? false
		})
		.returning();
	if (!attempt) throw new Error('attempt was not inserted');
	const outcome = await advance(tx, deps, attempt, {
		now,
		requestId: options.requestId,
		createdBy: { kind: 'user', id: options.userId }
	});
	return { attempt, outcome };
}

// --- Answering --------------------------------------------------------------------------------------------------

export type AnswerPayload =
	| { kind: 'answer'; answer: CandidateAnswer }
	| { kind: 'code'; language: string; source: string }
	| { kind: 'cases'; cases: QaCase[] }
	| { kind: 'change_step_code'; language: string; source: string }
	| { kind: 'change_step_cases'; cases: QaCase[] };

export interface AnswerResult {
	attemptId: string;
	/** `pending` — the cluster went to the sandbox; the next item is served when the candidate's move allows it. */
	outcome: AdvanceOutcome | { kind: 'pending'; next: AdvanceOutcome };
}

/** The candidate's attempt, locked, in progress and within its deadline. */
export async function lockOwnAttempt(
	tx: Transaction,
	candidateId: string,
	attemptId: string,
	now: Date
): Promise<AttemptRow> {
	const [attempt] = await tx
		.select()
		.from(testAttempts)
		.where(and(eq(testAttempts.id, attemptId), eq(testAttempts.candidateId, candidateId)))
		.for('update');
	if (!attempt) throw new ApiError('not_found');
	if (attempt.status === 'expired') throw conflict('attempt_expired', 'Время попытки истекло');
	if (attempt.status !== 'in_progress') throw conflict('attempt_closed', 'Попытка уже завершена');
	if (attempt.deadlineAt <= now) throw conflict('attempt_expired', 'Время попытки истекло');
	await requireProcessingConsent(tx, candidateId, now);
	return attempt;
}

function checkLanguage(instance: ItemInstance, language: string): void {
	if (!instance.practice || !(instance.practice.languages as readonly string[]).includes(language)) {
		throw invalidField('language', 'Этот язык для задания недоступен');
	}
}

function checkSource(source: string): void {
	if (source.trim() === '') throw invalidField('source', 'Решение пустое');
	if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
		throw invalidField('source', `Решение больше ${MAX_SOURCE_BYTES / 1024} КБ`);
	}
}

/** Answers the current cluster of an attempt (contracts 9.1). */
export async function answerItemIn(
	tx: Transaction,
	deps: EngineDeps,
	candidateId: string,
	attemptId: string,
	seq: number,
	payload: AnswerPayload,
	signals: ClientSignals | null,
	options: { now: Date; requestId: string; userId: string | undefined }
): Promise<AnswerResult> {
	const { now } = options;
	const attempt = await lockOwnAttempt(tx, candidateId, attemptId, now);
	const [current] = await tx
		.select()
		.from(testItems)
		.where(and(eq(testItems.attemptId, attempt.id), inArray(testItems.status, ['served', 'answered'])));
	if (current?.seq !== seq) {
		throw conflict('item_not_current', 'Это задание уже отвечено или ещё не открыто');
	}
	const instance = current.instance as ItemInstance;
	const stepStage = current.status === 'answered';
	const context = { now, requestId: options.requestId, createdBy: { kind: 'user' as const, id: options.userId } };
	const entry: SignalEntry = {
		at: now.toISOString(),
		stage: stepStage ? 'change_step' : current.practice ? 'submission' : 'answer',
		seq,
		responseMs: Math.max(0, now.getTime() - (current.answeredAt ?? current.servedAt).getTime()),
		client: signals
	};

	if (!current.practice) {
		if (payload.kind !== 'answer' || !instance.answer) throw invalidField('answer', 'Нужен ответ на задание');
		const correct = answerMatches(instance.answer, payload.answer);
		const foreign = correct ? null : await foreignAnswerOf(tx, attempt, current, payload.answer);
		await writeSignal(tx, attempt, foreign === null ? entry : { ...entry, foreignAnswer: foreign });
		await appendArtifacts(
			tx,
			attempt.id,
			current.id,
			[{ kind: 'answer', content: { seq, answer: payload.answer } }],
			now
		);
		await tx
			.update(testItems)
			.set({ status: 'scored', score: correct ? 1 : 0, scoreDetail: { correct }, answeredAt: now })
			.where(eq(testItems.id, current.id));
		return { attemptId: attempt.id, outcome: await advance(tx, deps, attempt, context) };
	}

	await writeSignal(tx, attempt, entry);
	if (stepStage) {
		const step = instance.changeStep;
		if (!step) throw new Error(`item ${current.id} is answered without a change step`);
		if (step.qa) {
			if (payload.kind !== 'change_step_cases')
				throw invalidField('change_step', 'Нужны тест-кейсы для изменённой спецификации');
			if (!instance.qa) throw new Error(`QA step of item ${current.id} without a QA task`);
			return submitCases(tx, deps, attempt, current, 'change_step', instance.qa.budget, payload.cases, context);
		}
		if (payload.kind !== 'change_step_code')
			throw invalidField('change_step', 'Нужна программа для изменённого условия');
		checkLanguage(instance, payload.language);
		checkSource(payload.source);
		return submitToSandbox(tx, deps, attempt, current, 'change_step', payload.language, payload.source, context);
	}

	if (instance.practice) {
		if (payload.kind !== 'code') throw invalidField('source', 'Нужна программа');
		checkLanguage(instance, payload.language);
		checkSource(payload.source);
		return submitToSandbox(tx, deps, attempt, current, 'task', payload.language, payload.source, context);
	}
	if (!instance.qa) throw new Error(`practice item ${current.id} is neither a program nor QA`);
	if (payload.kind !== 'cases') throw invalidField('cases', 'Нужны тест-кейсы');
	return submitCases(tx, deps, attempt, current, 'task', instance.qa.budget, payload.cases, context);
}

async function writeSignal(tx: Transaction, attempt: AttemptRow, entry: SignalEntry): Promise<void> {
	await tx
		.update(testAttempts)
		.set({ integritySignals: appendSignal(attempt.integritySignals, entry) })
		.where(eq(testAttempts.id, attempt.id));
}

/**
 * A wrong computed answer that is the right answer of another candidate's instance of the same family and grade
 * (`foreignInstance` of `leak.ts`): compared with the `FOREIGN_COMPARED` newest such instances, read as stored — nothing
 * is generated again. `null` — none.
 */
async function foreignAnswerOf(
	tx: Transaction,
	attempt: AttemptRow,
	item: ItemRow,
	given: CandidateAnswer
): Promise<SignalEntry['foreignAnswer'] | null> {
	const rows = await tx
		.select({ classId: testItems.classId, instance: testItems.instance })
		.from(testItems)
		.innerJoin(testAttempts, eq(testAttempts.id, testItems.attemptId))
		.where(
			and(
				eq(testItems.familyKey, item.familyKey),
				eq(testItems.practice, false),
				eq(testAttempts.grade, attempt.grade),
				ne(testAttempts.candidateId, attempt.candidateId)
			)
		)
		.orderBy(desc(testItems.servedAt))
		.limit(FOREIGN_COMPARED);
	const others = rows.flatMap((row) => {
		const answer = (row.instance as ItemInstance).answer;
		return answer === null ? [] : [{ classId: row.classId, answer }];
	});
	const match = foreignInstance(given, others);
	return match === null ? null : { classId: match.classId, sameClass: match.classId === item.classId };
}

async function submitCases(
	tx: Transaction,
	deps: EngineDeps,
	attempt: AttemptRow,
	item: ItemRow,
	stage: 'task' | 'change_step',
	budget: { min: number; max: number },
	cases: readonly QaCase[],
	context: { now: Date; requestId: string; createdBy: JobCreator }
): Promise<AnswerResult> {
	if (cases.length < budget.min) throw policyViolation('qa_budget_too_small', 'cases');
	if (cases.length > budget.max) throw policyViolation('qa_budget_exceeded', 'cases');
	const [artifactId] = await appendArtifacts(
		tx,
		attempt.id,
		item.id,
		[{ kind: 'qa_cases', content: { seq: item.seq, stage, cases } }],
		context.now
	);
	if (!artifactId) throw new Error('artifact was not inserted');
	await tx
		.update(testItems)
		.set({ status: 'awaiting_sandbox', answeredAt: context.now })
		.where(eq(testItems.id, item.id));
	await enqueueJob(
		tx,
		'test.run',
		{ artifact_id: artifactId },
		{ inputVersion: artifactId, createdBy: context.createdBy }
	);
	return { attemptId: attempt.id, outcome: { kind: 'pending', next: await advance(tx, deps, attempt, context) } };
}

async function submitToSandbox(
	tx: Transaction,
	deps: EngineDeps,
	attempt: AttemptRow,
	item: ItemRow,
	stage: 'task' | 'change_step',
	language: string,
	source: string,
	context: { now: Date; requestId: string; createdBy: JobCreator }
): Promise<AnswerResult> {
	const id = uuidv7();
	const draft = codeSubmissionArtifact({ requestId: id, language, source });
	await appendArtifacts(
		tx,
		attempt.id,
		item.id,
		[{ id, kind: 'code_submission', content: { ...draft.content, seq: item.seq, stage } }],
		context.now
	);
	await tx
		.update(testItems)
		.set({ status: 'awaiting_sandbox', answeredAt: context.now })
		.where(eq(testItems.id, item.id));
	await enqueueJob(tx, 'test.run', { artifact_id: id }, { inputVersion: id, createdBy: context.createdBy });
	return { attemptId: attempt.id, outcome: { kind: 'pending', next: await advance(tx, deps, attempt, context) } };
}

/** The family descriptor of an item, from the release of its attempt. */
export async function itemFamily(executor: Executor, attempt: AttemptRow, item: ItemRow): Promise<FamilyDescriptor> {
	const release = await releaseById(executor, attempt.bankReleaseId);
	const family = release.families.find((f) => f.descriptor.key === item.familyKey);
	if (!family) throw new Error(`family ${item.familyKey} is not in ${release.id}`);
	return family.descriptor;
}

// --- Entry points of a request -----------------------------------------------------------------------------------

/** The candidate starts a test of a grade (contracts 9.1, `POST /me/tests`). */
export async function startAttempt(
	database: Database,
	deps: EngineDeps,
	subject: AccessSubject,
	input: StartInput,
	options: { now: Date; requestId: string }
): Promise<{ attempt: AttemptRow; outcome: AdvanceOutcome }> {
	const candidateId = ownCandidateId(subject, 'write');
	return database.transaction((tx) =>
		startAttemptIn(tx, deps, candidateId, input, { ...options, userId: subject.userId ?? undefined })
	);
}

/** The candidate answers the current cluster of an attempt (`POST /me/tests/{id}/items/{seq}/answer`). */
export async function answerItem(
	database: Database,
	deps: EngineDeps,
	subject: AccessSubject,
	input: { attemptId: string; seq: number; payload: AnswerPayload; signals: ClientSignals | null },
	options: { now: Date; requestId: string }
): Promise<AnswerResult> {
	const candidateId = ownCandidateId(subject, 'write');
	// The expiry survives the refusal that follows it: it is written before the answer's transaction.
	await expireOverdue(database, candidateId, options.now);
	return database.transaction((tx) =>
		answerItemIn(tx, deps, candidateId, input.attemptId, input.seq, input.payload, input.signals, {
			...options,
			userId: subject.userId ?? undefined
		})
	);
}
