// Requests of a missing confirmation (docs/domain.md, 13.11; contracts 9.1, 9.2). The employer asks a candidate it sees
// to confirm a block × grade pair of the candidate's specialization that the category does not cover; the candidate
// takes the block test of their own will — refusing changes nothing. The result is evidence of its own: the category
// never changes. A repeated request returns the open one; a result of the block on the same or a higher grade the
// company sees closes the question without a new test.
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import { gradesFrom, blockTestAllowed } from '$lib/server/assessments/block-test';
import { openSpecializations, type ModuleSource } from '$lib/server/assessments/bank-store';
import {
	CATALOG,
	gradeDefinition,
	type GradeKey,
	type SpecializationKey
} from '$lib/server/assessments/contract/catalog';
import { startBlockAttemptIn, type AdvanceOutcome } from '$lib/server/assessments/engine';
import { OWNER_STANDING } from '$lib/server/assessments/standing';
import { testTitle } from '$lib/server/assessments/titles';
import { recordAuditEvent } from '$lib/server/audit/record';
import { activeCategories } from '$lib/server/categories/read';
import { admissionRefusal, loadCompanyAdmission } from '$lib/server/companies/gate';
import type { FieldCrypto } from '$lib/server/crypto/fields';
import type { Database, Executor, Transaction } from '$lib/server/db';
import {
	blockConfirmations,
	candidates,
	companies,
	confirmationRequests,
	gradeDeclarations,
	hiringNeeds,
	invitations,
	testAttempts
} from '$lib/server/db/schema';
import { demoSessionOfUser, inDemoScope } from '$lib/server/demo/scope';
import { ApiError, policyViolation } from '$lib/server/errors/api-error';
import { auditActor, type RequestMeta } from '$lib/server/invitations/deps';
import { refuse } from '$lib/server/invitations/errors';
import { candidateSide, memberSide } from '$lib/server/invitations/records';
import { showInOfferContext } from '$lib/server/invitations/visibility';
import { defineHandler, JobFailure, type JobHandler, type JobResult } from '$lib/server/jobs/handler';
import { cancelWaitingJobs, enqueueJob } from '$lib/server/jobs/queue';
import { notify } from '$lib/server/notifications/notify';
import { completeRequest } from './complete';
import { syncBlockFact } from './fact';

/** How long the candidate has to answer a request (domain 13.11). */
export const REQUEST_ANSWER_DAYS = 14;
const DAY = 86_400_000;

export interface ConfirmationDeps {
	db: Database;
	crypto: Pick<FieldCrypto, 'pseudonym'>;
	now: () => Date;
	/** Generators of the families of a release for the block test; the bank tree by default. */
	modules?: ModuleSource;
}

type RequestRow = typeof confirmationRequests.$inferSelect;
type ResultRow = typeof blockConfirmations.$inferSelect;

export interface BlockResultView {
	id: string;
	specialization: SpecializationKey;
	block: string;
	blockTitle: string;
	grade: GradeKey;
	verdict: 'confirmed' | 'not_confirmed';
	/** Sums in twentieths of a point over the four clusters. */
	scoreSum: number;
	cutSum: number;
	status: 'valid' | 'annulled';
	visibility: 'requester' | 'all_companies';
	bankReleaseId: string;
	decidedAt: Date;
	/** The skills the block confirms (the area the result covers). */
	skillKeys: readonly string[];
	/** What the block checks, in words. */
	checks: string;
}

export interface ConfirmationRequestView {
	id: string;
	companyId: string;
	companyName: string;
	/** The candidate for the company: the pseudonym; `null` on the candidate's own side. */
	candidatePseudonym: string | null;
	specialization: SpecializationKey;
	block: string;
	blockTitle: string;
	grade: GradeKey;
	title: string;
	status: RequestRow['status'];
	invitationId: string | null;
	needId: string | null;
	expiresAt: Date;
	createdAt: Date;
	answeredAt: Date | null;
	result: BlockResultView | null;
	/** The block test the candidate is taking for the request; `null` — none in progress. */
	attemptId: string | null;
}

function blockOf(code: string) {
	return CATALOG.blocks.find((block) => block.code === code) ?? null;
}

export function resultView(row: ResultRow): BlockResultView {
	const block = blockOf(row.block);
	if (!block) throw new Error(`block ${row.block} of result ${row.id} is not in the catalog`);
	return {
		id: row.id,
		specialization: row.specialization,
		block: row.block,
		blockTitle: block.title,
		grade: row.grade,
		verdict: row.verdict,
		scoreSum: row.scoreSum,
		cutSum: row.cutSum,
		status: row.status,
		visibility: row.visibility,
		bankReleaseId: row.bankReleaseId,
		decidedAt: row.decidedAt,
		skillKeys: block.skillKeys,
		checks: block.checks
	};
}

/**
 * Valid results of the candidate the company sees: opened to every company, or the result that closed a request of this
 * company. `blocks` limits them to these blocks.
 */
export async function resultsVisibleTo(
	executor: Executor,
	companyId: string,
	candidateId: string,
	filter: { block?: string; grades?: readonly GradeKey[]; confirmedOnly?: boolean } = {}
): Promise<ResultRow[]> {
	return executor
		.select()
		.from(blockConfirmations)
		.where(
			and(
				eq(blockConfirmations.candidateId, candidateId),
				eq(blockConfirmations.status, 'valid'),
				filter.block === undefined ? undefined : eq(blockConfirmations.block, filter.block),
				filter.grades === undefined ? undefined : inArray(blockConfirmations.grade, [...filter.grades]),
				filter.confirmedOnly === true ? eq(blockConfirmations.verdict, 'confirmed') : undefined,
				or(
					eq(blockConfirmations.visibility, 'all_companies'),
					sql`exists (select 1 from ${confirmationRequests} cr where cr.confirmation_id = ${blockConfirmations.id}
						and cr.company_id = ${companyId})`
				)
			)
		)
		.orderBy(desc(blockConfirmations.decidedAt));
}

/** The pair a block of the candidate is requested at: the grade of the category of its specialization, else the declared one. */
async function requestedPair(
	executor: Executor,
	candidateId: string,
	block: string
): Promise<{ specialization: SpecializationKey; grade: GradeKey; defining: readonly string[] }> {
	const definition = blockOf(block);
	if (!definition || definition.practice) {
		throw new ApiError('validation_failed', {
			details: [{ path: 'block', code: 'unknown', message: 'Неизвестный блок теста' }]
		});
	}
	const specialization = definition.specialization;
	if (!(await openSpecializations(executor)).has(specialization))
		throw policyViolation('specialization_closed', 'block');
	const category = ((await activeCategories(executor, [candidateId])).get(candidateId) ?? []).find(
		(c) => c.specialization === specialization
	);
	if (category) {
		return {
			specialization,
			grade: category.grade,
			defining: gradeDefinition(specialization, category.grade).defining
		};
	}
	const [declared] = await executor
		.select({ grade: gradeDeclarations.grade })
		.from(gradeDeclarations)
		.where(and(eq(gradeDeclarations.candidateId, candidateId), eq(gradeDeclarations.specialization, specialization)))
		.orderBy(desc(gradeDeclarations.declaredAt))
		.limit(1);
	if (!declared) {
		throw refuse('conflict', 'grade_unknown', [
			{
				path: 'block',
				code: 'grade_unknown',
				message: 'У кандидата нет ни категории, ни заявленного грейда этой специализации'
			}
		]);
	}
	return { specialization, grade: declared.grade, defining: [] };
}

export type RequestOutcome =
	| { kind: 'request'; request: ConfirmationRequestView; created: boolean }
	/** A result of the block on the same or a higher grade the company already sees: no new test is asked for. */
	| { kind: 'result'; result: BlockResultView };

export interface RequestInput {
	candidateId: string;
	block: string;
	invitationId?: string | null;
	needId?: string | null;
}

/**
 * The company asks the candidate to confirm a block (`POST /api/v1/confirmation-requests`). Refusals: the company the
 * admission policy closed (`403`), a candidate it does not see (`404`), an unknown block (`400`), a closed
 * specialization, a defining block of the category in force (`422 confirmation_block_confirmed`), a pair without a
 * block test (`422 block_not_testable`).
 */
export async function requestConfirmation(
	deps: ConfirmationDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	input: RequestInput
): Promise<RequestOutcome> {
	return deps.db.transaction(async (tx) => {
		const now = deps.now();
		const member = memberSide(subject);
		const admission = await loadCompanyAdmission(tx, member.companyId);
		if (!admission.admitted) throw admissionRefusal(admission.reason);
		const { decision } = await showInOfferContext(tx, subject, input.candidateId, null, now);
		if (!decision.allowed) throw refuse('not_found', decision.reason);
		if (!can(subject, 'confirmation.request', { show: decision }).allowed) throw refuse('forbidden', 'permission');

		const pair = await requestedPair(tx, input.candidateId, input.block);
		if (pair.defining.includes(input.block)) throw policyViolation('confirmation_block_confirmed', 'block');
		if (!blockTestAllowed(pair.specialization, input.block, pair.grade)) {
			throw policyViolation('block_not_testable', 'block');
		}
		const invitationId = input.invitationId?.trim() ? input.invitationId.trim() : null;
		if (invitationId !== null) {
			const [own] = await tx
				.select({ id: invitations.id })
				.from(invitations)
				.where(
					and(
						eq(invitations.id, invitationId),
						eq(invitations.companyId, member.companyId),
						eq(invitations.candidateId, input.candidateId)
					)
				);
			if (!own) throw refuse('not_found', 'foreign_invitation');
		}
		const needId = input.needId?.trim() ? input.needId.trim() : null;
		if (needId !== null) {
			const [own] = await tx
				.select({ id: hiringNeeds.id })
				.from(hiringNeeds)
				.where(and(eq(hiringNeeds.id, needId), eq(hiringNeeds.companyId, member.companyId)));
			if (!own) throw refuse('not_found', 'foreign_need');
		}

		const [visible] = await resultsVisibleTo(tx, member.companyId, input.candidateId, {
			block: input.block,
			grades: gradesFrom(pair.grade),
			confirmedOnly: true
		});
		if (visible) return { kind: 'result', result: resultView(visible) };

		const open = await openRequest(tx, member.companyId, input.candidateId, input.block, pair.grade);
		if (open) return { kind: 'request', request: await requestView(tx, deps.crypto, open, 'company'), created: false };

		const expiresAt = new Date(now.getTime() + REQUEST_ANSWER_DAYS * DAY);
		const [inserted] = await tx
			.insert(confirmationRequests)
			.values({
				companyId: member.companyId,
				requestedByMemberId: member.memberId,
				candidateId: input.candidateId,
				invitationId,
				needId,
				specialization: pair.specialization,
				block: input.block,
				grade: pair.grade,
				status: 'requested',
				expiresAt,
				createdAt: now
			})
			.onConflictDoNothing()
			.returning();
		if (!inserted) {
			// A concurrent request of the same pair committed in between: it is the open one.
			const raced = await openRequest(tx, member.companyId, input.candidateId, input.block, pair.grade);
			if (!raced) throw new Error('a request conflicted with no open request of the pair');
			return { kind: 'request', request: await requestView(tx, deps.crypto, raced, 'company'), created: false };
		}
		await enqueueJob(
			tx,
			'confirmation.expire',
			{ request_id: inserted.id },
			{ inputVersion: inserted.id, createdBy: { kind: 'user', id: member.userId }, runAfter: expiresAt }
		);
		await notify(tx, {
			userId: await userOfCandidate(tx, input.candidateId),
			type: 'confirmation.requested',
			objectId: inserted.id,
			payload: { request_id: inserted.id }
		});
		await recordAuditEvent(tx, {
			action: 'confirmation.requested',
			outcome: 'success',
			actor: auditActor(subject, meta, 'company'),
			object: { type: 'confirmation_request', id: inserted.id },
			subjectCandidateId: input.candidateId,
			requestId: meta.requestId,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null,
			details: { block: input.block, grade: pair.grade, invitation_id: invitationId, need_id: needId },
			occurredAt: now
		});
		return { kind: 'request', request: await requestView(tx, deps.crypto, inserted, 'company'), created: true };
	});
}

async function openRequest(
	executor: Executor,
	companyId: string,
	candidateId: string,
	block: string,
	grade: GradeKey
): Promise<RequestRow | null> {
	const [row] = await executor
		.select()
		.from(confirmationRequests)
		.where(
			and(
				eq(confirmationRequests.companyId, companyId),
				eq(confirmationRequests.candidateId, candidateId),
				eq(confirmationRequests.block, block),
				eq(confirmationRequests.grade, grade),
				inArray(confirmationRequests.status, ['requested', 'accepted'])
			)
		);
	return row ?? null;
}

async function userOfCandidate(executor: Executor, candidateId: string): Promise<string> {
	const [row] = await executor
		.select({ userId: candidates.userId })
		.from(candidates)
		.where(eq(candidates.id, candidateId));
	if (!row) throw new Error(`candidate ${candidateId} does not exist`);
	return row.userId;
}

async function requestView(
	executor: Executor,
	crypto: Pick<FieldCrypto, 'pseudonym'>,
	row: RequestRow,
	side: 'company' | 'candidate'
): Promise<ConfirmationRequestView> {
	return (await requestViews(executor, crypto, [row], side))[0] ?? missing(row.id);
}

function missing(id: string): never {
	throw new Error(`view of request ${id} was not built`);
}

async function requestViews(
	executor: Executor,
	crypto: Pick<FieldCrypto, 'pseudonym'>,
	rows: readonly RequestRow[],
	side: 'company' | 'candidate'
): Promise<ConfirmationRequestView[]> {
	if (rows.length === 0) return [];
	const companyNames = new Map(
		(
			await executor
				.select({ id: companies.id, name: companies.displayName })
				.from(companies)
				.where(inArray(companies.id, [...new Set(rows.map((row) => row.companyId))]))
		).map((row) => [row.id, row.name])
	);
	const resultIds = rows.flatMap((row) => (row.confirmationId === null ? [] : [row.confirmationId]));
	const results = new Map(
		resultIds.length === 0
			? []
			: (await executor.select().from(blockConfirmations).where(inArray(blockConfirmations.id, resultIds))).map(
					(row) => [row.id, row]
				)
	);
	const attempts = new Map(
		(
			await executor
				.select({ id: testAttempts.id, requestId: testAttempts.confirmationRequestId })
				.from(testAttempts)
				.where(
					and(
						inArray(
							testAttempts.confirmationRequestId,
							rows.map((row) => row.id)
						),
						eq(testAttempts.status, 'in_progress')
					)
				)
		).map((row) => [row.requestId, row.id])
	);
	return rows.map((row) => {
		const block = blockOf(row.block);
		if (!block) throw new Error(`block ${row.block} of request ${row.id} is not in the catalog`);
		const result = row.confirmationId === null ? null : results.get(row.confirmationId);
		if (result === undefined) throw new Error(`result of request ${row.id} is missing`);
		return {
			id: row.id,
			companyId: row.companyId,
			companyName: companyNames.get(row.companyId) ?? missing(row.id),
			candidatePseudonym: side === 'company' ? crypto.pseudonym(row.candidateId, row.companyId) : null,
			specialization: row.specialization,
			block: row.block,
			blockTitle: block.title,
			grade: row.grade,
			title: testTitle(row.specialization, row.grade),
			status: row.status,
			invitationId: row.invitationId,
			needId: row.needId,
			expiresAt: row.expiresAt,
			createdAt: row.createdAt,
			answeredAt: row.answeredAt,
			result: result === null ? null : resultView(result),
			attemptId: attempts.get(row.id) ?? null
		};
	});
}

/** The requests of the subject's company, of one candidate when given, newest first. */
export async function companyRequests(
	deps: ConfirmationDeps,
	subject: AccessSubject,
	candidateId: string | null
): Promise<ConfirmationRequestView[]> {
	const member = memberSide(subject);
	if (!can(subject, 'catalog.search', null).allowed) throw refuse('forbidden', 'permission');
	const rows = await deps.db
		.select()
		.from(confirmationRequests)
		.where(
			and(
				eq(confirmationRequests.companyId, member.companyId),
				candidateId === null ? undefined : eq(confirmationRequests.candidateId, candidateId)
			)
		)
		.orderBy(desc(confirmationRequests.createdAt));
	return requestViews(deps.db, deps.crypto, rows, 'company');
}

/** The blocks a company may ask the candidate to confirm now, with what the card already shows of each. */
export interface RequestableBlock {
	block: string;
	title: string;
	checks: string;
	specialization: SpecializationKey;
	grade: GradeKey;
}

/** Pairs of block × grade a request may name for the candidate: their specializations, minus the defining blocks. */
export async function requestableBlocks(executor: Executor, candidateId: string): Promise<RequestableBlock[]> {
	const open = await openSpecializations(executor);
	const categories = (await activeCategories(executor, [candidateId])).get(candidateId) ?? [];
	const declared = await executor
		.select({ specialization: gradeDeclarations.specialization, grade: gradeDeclarations.grade })
		.from(gradeDeclarations)
		.where(eq(gradeDeclarations.candidateId, candidateId))
		.orderBy(asc(gradeDeclarations.declaredAt));
	const pairs = new Map<SpecializationKey, { grade: GradeKey; defining: readonly string[] }>();
	for (const row of declared) pairs.set(row.specialization, { grade: row.grade, defining: [] });
	for (const category of categories) {
		pairs.set(category.specialization, {
			grade: category.grade,
			defining: gradeDefinition(category.specialization, category.grade).defining
		});
	}
	const blocks: RequestableBlock[] = [];
	for (const [specialization, pair] of pairs) {
		if (!open.has(specialization)) continue;
		for (const block of CATALOG.blocks.filter((b) => b.specialization === specialization && !b.practice)) {
			if (pair.defining.includes(block.code) || !blockTestAllowed(specialization, block.code, pair.grade)) continue;
			blocks.push({ block: block.code, title: block.title, checks: block.checks, specialization, grade: pair.grade });
		}
	}
	return blocks;
}

// --- The candidate's side -----------------------------------------------------------------------------------------

/** A company of the request in the candidate's place (domain 19.3); any other request is «not found». */
async function requireReach(executor: Executor, userId: string, companyId: string): Promise<void> {
	const [company] = await executor
		.select({ demoSessionId: companies.demoSessionId, demoOriginal: companies.demoOriginal })
		.from(companies)
		.where(eq(companies.id, companyId));
	if (!company) throw new Error(`company ${companyId} does not exist`);
	if (!inDemoScope(company, await demoSessionOfUser(executor, userId))) throw refuse('not_found', 'not_in_demo_scope');
}

export interface CandidateConfirmations {
	requests: ConfirmationRequestView[];
	results: BlockResultView[];
}

/** The candidate's requests of the companies within reach and their own block results (`GET /me/confirmation-requests`). */
export async function candidateConfirmations(
	deps: ConfirmationDeps,
	subject: AccessSubject
): Promise<CandidateConfirmations> {
	const side = candidateSide(subject);
	if (!can(subject, 'candidate.self.read', { candidateId: side.candidateId }).allowed) {
		throw refuse('forbidden', 'permission');
	}
	const session = await demoSessionOfUser(deps.db, side.userId);
	const rows = await deps.db
		.select({
			request: confirmationRequests,
			demoSessionId: companies.demoSessionId,
			demoOriginal: companies.demoOriginal
		})
		.from(confirmationRequests)
		.innerJoin(companies, eq(companies.id, confirmationRequests.companyId))
		.where(eq(confirmationRequests.candidateId, side.candidateId))
		.orderBy(desc(confirmationRequests.createdAt));
	const reachable = rows.filter((row) => inDemoScope(row, session)).map((row) => row.request);
	const results = await deps.db
		.select()
		.from(blockConfirmations)
		.where(eq(blockConfirmations.candidateId, side.candidateId))
		.orderBy(desc(blockConfirmations.decidedAt));
	return {
		requests: await requestViews(deps.db, deps.crypto, reachable, 'candidate'),
		results: results.map(resultView)
	};
}

async function lockOwnRequest(tx: Transaction, candidateId: string, userId: string, requestId: string) {
	const [row] = await tx
		.select()
		.from(confirmationRequests)
		.where(eq(confirmationRequests.id, requestId))
		.for('update');
	if (!row || row.candidateId !== candidateId) throw refuse('not_found', 'not_addressee');
	await requireReach(tx, userId, row.companyId);
	return row;
}

function requireAnswerable(row: RequestRow, now: Date): void {
	if (row.status === 'expired' || (row.status === 'requested' && row.expiresAt <= now)) {
		throw refuse('conflict', 'request_expired', [{ code: 'request_expired', message: 'Срок ответа на запрос истёк' }]);
	}
	if (row.status !== 'requested') {
		throw refuse('conflict', 'already_answered', [{ code: 'already_answered', message: 'На запрос уже ответили' }]);
	}
}

export type AcceptOutcome =
	/** The block test started: the candidate takes it on the page of the attempt. */
	| { kind: 'started'; attemptId: string; outcome: AdvanceOutcome }
	/** A result of the block on the same or a higher grade closed the request: no new test. */
	| { kind: 'completed'; confirmationId: string };

/**
 * The candidate accepts (`POST /me/confirmation-requests/{id}/accept`): a confirmed valid result of the block on the
 * same or a higher grade closes the request — sharing it with this company is the candidate's act; otherwise the
 * block test starts in the same transaction, and a refusal of the start leaves the request unanswered.
 */
export async function acceptRequest(
	deps: ConfirmationDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	requestId: string
): Promise<AcceptOutcome> {
	const side = candidateSide(subject);
	if (!can(subject, 'candidate.self.write', { candidateId: side.candidateId }).allowed) {
		throw refuse('forbidden', 'permission');
	}
	return deps.db.transaction(async (tx) => {
		const now = deps.now();
		const request = await lockOwnRequest(tx, side.candidateId, side.userId, requestId);
		requireAnswerable(request, now);
		const journal = {
			actor: auditActor(subject, meta, 'candidate'),
			object: { type: 'confirmation_request', id: request.id },
			subjectCandidateId: side.candidateId,
			requestId: meta.requestId,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null,
			occurredAt: now
		};
		const [existing] = await tx
			.select()
			.from(blockConfirmations)
			.where(
				and(
					eq(blockConfirmations.candidateId, side.candidateId),
					eq(blockConfirmations.block, request.block),
					inArray(blockConfirmations.grade, gradesFrom(request.grade)),
					eq(blockConfirmations.status, 'valid'),
					eq(blockConfirmations.verdict, 'confirmed')
				)
			)
			.orderBy(desc(blockConfirmations.decidedAt))
			.limit(1);
		await recordAuditEvent(tx, {
			...journal,
			action: 'confirmation.answered',
			outcome: 'success',
			details: { decision: 'accept', with_existing_result: existing !== undefined }
		});
		if (existing) {
			await completeRequest(tx, request.id, existing.id, {
				now,
				requestId: meta.requestId,
				verdict: existing.verdict
			});
			return { kind: 'completed', confirmationId: existing.id };
		}
		await tx
			.update(confirmationRequests)
			.set({ status: 'accepted', answeredAt: now })
			.where(eq(confirmationRequests.id, request.id));
		const { attempt, outcome } = await startBlockAttemptIn(
			tx,
			{ standing: OWNER_STANDING, ...(deps.modules ? { modules: deps.modules } : {}) },
			side.candidateId,
			{ requestId: request.id, specialization: request.specialization, block: request.block, grade: request.grade },
			{ now, requestId: meta.requestId, userId: side.userId }
		);
		return { kind: 'started', attemptId: attempt.id, outcome };
	});
}

/** The candidate declines (`POST /me/confirmation-requests/{id}/decline`): nothing else changes. */
export async function declineRequest(
	deps: ConfirmationDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	requestId: string
): Promise<void> {
	const side = candidateSide(subject);
	if (!can(subject, 'candidate.self.write', { candidateId: side.candidateId }).allowed) {
		throw refuse('forbidden', 'permission');
	}
	await deps.db.transaction(async (tx) => {
		const now = deps.now();
		const request = await lockOwnRequest(tx, side.candidateId, side.userId, requestId);
		requireAnswerable(request, now);
		await tx
			.update(confirmationRequests)
			.set({ status: 'declined', answeredAt: now })
			.where(eq(confirmationRequests.id, request.id));
		await cancelWaitingJobs(tx, 'confirmation.expire', { request_id: request.id });
		await recordAuditEvent(tx, {
			action: 'confirmation.answered',
			outcome: 'success',
			actor: auditActor(subject, meta, 'candidate'),
			object: { type: 'confirmation_request', id: request.id },
			subjectCandidateId: side.candidateId,
			requestId: meta.requestId,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null,
			details: { decision: 'decline' },
			occurredAt: now
		});
	});
}

/** Who sees a result of the candidate's block test (`PUT /me/block-confirmations/{id}/visibility`). */
export async function setResultVisibility(
	deps: ConfirmationDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	confirmationId: string,
	visibility: 'requester' | 'all_companies'
): Promise<BlockResultView> {
	const side = candidateSide(subject);
	if (!can(subject, 'candidate.self.write', { candidateId: side.candidateId }).allowed) {
		throw refuse('forbidden', 'permission');
	}
	return deps.db.transaction(async (tx) => {
		const [row] = await tx
			.update(blockConfirmations)
			.set({ visibility })
			.where(and(eq(blockConfirmations.id, confirmationId), eq(blockConfirmations.candidateId, side.candidateId)))
			.returning();
		if (!row) throw refuse('not_found', 'not_owner');
		await syncBlockFact(tx, row.id, { kind: 'user', id: side.userId });
		await recordAuditEvent(tx, {
			action: 'confirmation.visibility_changed',
			outcome: 'success',
			actor: auditActor(subject, meta, 'candidate'),
			object: { type: 'block_confirmation', id: row.id },
			subjectCandidateId: side.candidateId,
			requestId: meta.requestId,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null,
			details: { visibility },
			occurredAt: deps.now()
		});
		return resultView(row);
	});
}

// --- Expiry -------------------------------------------------------------------------------------------------------

/**
 * `confirmation.expire` at the deadline of a request: a request not completed by then expires. A block test of the
 * request still in progress finishes first: the job comes back at its deadline.
 */
export function createConfirmationExpireHandler(clock: { now: () => Date }): JobHandler<'confirmation.expire'> {
	return defineHandler({
		type: 'confirmation.expire',
		concurrency: 2,
		async run({ job, db, requestId }): Promise<JobResult> {
			const id = job.payload.request_id;
			const now = clock.now();
			const [request] = await db.select().from(confirmationRequests).where(eq(confirmationRequests.id, id));
			const early = request ? request.expiresAt.getTime() - now.getTime() : 0;
			if (early > 0) {
				throw new JobFailure('not_due', 'the deadline of the request has not passed yet', {
					retryable: true,
					retryAfterSeconds: Math.ceil(early / 1000)
				});
			}
			const [running] = await db
				.select({ deadlineAt: testAttempts.deadlineAt })
				.from(testAttempts)
				.where(and(eq(testAttempts.confirmationRequestId, id), eq(testAttempts.status, 'in_progress')));
			if (running) {
				throw new JobFailure('attempt_in_progress', 'the block test of the request is still in progress', {
					retryable: true,
					retryAfterSeconds: Math.max(1, Math.ceil((running.deadlineAt.getTime() - now.getTime()) / 1000))
				});
			}
			return {
				isCurrent: async (tx) => {
					const [row] = await tx
						.select({ status: confirmationRequests.status })
						.from(confirmationRequests)
						.where(eq(confirmationRequests.id, id))
						.for('update');
					return row?.status === 'requested' || row?.status === 'accepted';
				},
				write: async (tx) => {
					const [row] = await tx
						.update(confirmationRequests)
						.set({ status: 'expired' })
						.where(eq(confirmationRequests.id, id))
						.returning({ candidateId: confirmationRequests.candidateId });
					await recordAuditEvent(tx, {
						action: 'confirmation.expired',
						outcome: 'success',
						actor: { kind: 'system' },
						object: { type: 'confirmation_request', id },
						...(row ? { subjectCandidateId: row.candidateId } : {}),
						requestId,
						occurredAt: now
					});
				}
			};
		}
	});
}

export const confirmationExpire = createConfirmationExpireHandler({ now: () => new Date() });
