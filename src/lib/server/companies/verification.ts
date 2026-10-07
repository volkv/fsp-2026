// Verification of a company by an FSP operator (domain 5.1, 5.2): the owner submits the request with the way the
// applicant's authority is confirmed; the registry lookup is a hint; only the operator's decision makes a company
// `verified`. The operator may also send the request back for clarification, suspend and reinstate a company.
import { and, asc, count, desc, eq, gt, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { StaffReach } from '$lib/server/access/demo-actor';
import { companyAdmission } from '$lib/server/access/permissions';
import { recordAuditEvent } from '$lib/server/audit/record';
import { isValidInn } from '$lib/server/auth/inn';
import type { Transaction } from '$lib/server/db';
import { companies, companyMembers, companyVerifications, files, users } from '$lib/server/db/schema';
import { ApiError, type ErrorDetail } from '$lib/server/errors/api-error';
import { withdrawOpenInvitations } from '$lib/server/invitations/send';
import { enqueueJob } from '$lib/server/jobs/queue';
import { notify } from '$lib/server/notifications/notify';
import {
	auditActorOf,
	conflict,
	invalid,
	requirePermission,
	sessionUserId,
	type ActionContext,
	type CompanyDeps
} from './context';
import type { CompanyStatus } from './gate';
import { isInnTaken } from './inn-scope';
import { parseRegistryCheck, type RegistryCheck, type RegistryCheckState } from './registry-check';
import { isValidKpp, isValidOgrn } from './requisites';
import { lockCompany, type CompanyRow } from './rows';

export type AuthorityMethod = (typeof companyVerifications.$inferSelect)['authorityMethod'];

/** Methods confirmed by a document; a corporate address is checked by the operator without a file. */
const NEEDS_EVIDENCE: ReadonlySet<AuthorityMethod> = new Set([
	'director_self',
	'power_of_attorney',
	'signed_letter',
	'esign'
]);

/** Hours from submission to the due time of a decision. The value is a product decision, not a rule of the brief. */
export const REVIEW_DUE_HOURS = 48;

const REASON_MIN = 10;
const REASON_MAX = 2000;

const SUBMITTABLE: ReadonlySet<CompanyStatus> = new Set(['draft', 'rejected']);

function audit(ctx: ActionContext) {
	return {
		actor: auditActorOf(ctx.subject),
		requestId: ctx.meta.requestId,
		ip: ctx.meta.ip,
		userAgent: ctx.meta.userAgent
	};
}

function requisiteProblems(company: CompanyRow): ErrorDetail[] {
	const problems: ErrorDetail[] = [];
	if (!isValidInn(company.inn)) {
		problems.push({ path: 'inn', code: 'invalid_inn', message: 'ИНН не проходит проверку контрольной суммы' });
	}
	if (company.legalName.trim().length < 2) {
		problems.push({ path: 'legalName', code: 'required', message: 'Укажите полное наименование' });
	}
	if (company.displayName.trim().length < 2) {
		problems.push({ path: 'displayName', code: 'required', message: 'Укажите название для интерфейса' });
	}
	return problems;
}

export interface VerificationRequest {
	authorityMethod: AuthorityMethod;
	/** A file of purpose `company_authority_evidence` uploaded by the applicant; required unless the method is the address. */
	authorityEvidenceFileId: string | null;
}

/** The owner submits a `draft` or `rejected` company for verification. */
export async function submitForVerification(
	deps: CompanyDeps,
	ctx: ActionContext,
	companyId: string,
	request: VerificationRequest
): Promise<{ verificationId: string }> {
	requirePermission(ctx.subject, 'company.profile.manage', { companyId });
	const userId = sessionUserId(ctx.subject);
	const applicant = ctx.subject.membership;
	if (applicant === null) throw new Error('an owner of the company has no membership');
	const needsEvidence = NEEDS_EVIDENCE.has(request.authorityMethod);
	if (needsEvidence && request.authorityEvidenceFileId === null) {
		throw invalid([
			{ path: 'authorityEvidenceFileId', code: 'required', message: 'Приложите документ, подтверждающий полномочия' }
		]);
	}

	try {
		return await deps.db.transaction(async (tx) => {
			const company = await lockCompany(tx, companyId);
			if (!SUBMITTABLE.has(company.status)) {
				throw conflict('not_submittable', 'Заявка уже подана или компания уже проверена');
			}
			const problems = requisiteProblems(company);
			if (problems.length > 0) throw invalid(problems);
			if (request.authorityEvidenceFileId !== null) {
				const [file] = await tx
					.select({ id: files.id })
					.from(files)
					.where(
						and(
							eq(files.id, request.authorityEvidenceFileId),
							eq(files.ownerUserId, userId),
							eq(files.purpose, 'company_authority_evidence'),
							eq(files.status, 'ready')
						)
					);
				if (!file) {
					throw invalid([
						{ path: 'authorityEvidenceFileId', code: 'not_found', message: 'Документ не найден или ещё не обработан' }
					]);
				}
			}
			const [previous] = await tx
				.select({ n: count() })
				.from(companyVerifications)
				.where(eq(companyVerifications.companyId, companyId));
			await tx.update(companies).set({ status: 'submitted' }).where(eq(companies.id, companyId));
			const [verification] = await tx
				.insert(companyVerifications)
				.values({
					companyId,
					applicantMemberId: applicant.memberId,
					authorityMethod: request.authorityMethod,
					authorityEvidenceFileId: request.authorityEvidenceFileId
				})
				.returning({ id: companyVerifications.id });
			if (!verification) throw new Error('verification request not inserted');
			await enqueueJob(
				tx,
				'company.registry_lookup',
				{ company_id: companyId },
				{ inputVersion: verification.id, createdBy: { kind: 'user', id: userId } }
			);
			await recordAuditEvent(tx, {
				...audit(ctx),
				action: 'company.submitted',
				outcome: 'success',
				object: { type: 'company', id: companyId },
				details: {
					verification_id: verification.id,
					authority_method: request.authorityMethod,
					attempt: (previous?.n ?? 0) + 1
				}
			});
			return { verificationId: verification.id };
		});
	} catch (error) {
		// A rejected company frees its number; another company may have taken it before the resubmission.
		if (isInnTaken(error)) {
			throw conflict('inn_taken', 'Компания с этим ИНН уже заявлена на платформе другим работодателем', 'inn');
		}
		throw error;
	}
}

export interface VerificationQueueQuery {
	authorityMethods?: AuthorityMethod[];
	registry?: RegistryCheckState[];
	/** Only requests past their due time. */
	overdueOnly?: boolean;
	/** At most 100; 50 by default. */
	limit?: number;
	/** `nextCursor` of the previous page. */
	cursor?: string;
}

export interface VerificationQueueItem {
	verificationId: string;
	companyId: string;
	inn: string;
	legalName: string;
	displayName: string;
	authorityMethod: AuthorityMethod;
	hasEvidence: boolean;
	registryCheck: RegistryCheck | null;
	submittedAt: Date;
	dueAt: Date;
	overdue: boolean;
	/** 1 for a first request; more when the company was rejected or sent back before. */
	attempt: number;
}

function encodeCursor(submittedAt: Date, id: string): string {
	return Buffer.from(JSON.stringify([submittedAt.toISOString(), id]), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { submittedAt: Date; id: string } {
	try {
		const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
		if (Array.isArray(value) && typeof value[0] === 'string' && typeof value[1] === 'string') {
			const submittedAt = new Date(value[0]);
			if (!Number.isNaN(submittedAt.getTime())) return { submittedAt, id: value[1] };
		}
	} catch {
		throw invalid([{ path: 'cursor', code: 'invalid_cursor', message: 'Курсор страницы повреждён' }]);
	}
	throw invalid([{ path: 'cursor', code: 'invalid_cursor', message: 'Курсор страницы повреждён' }]);
}

/** Open requests of `submitted` companies, oldest first, with the due time of the decision. */
export async function verificationQueue(
	deps: CompanyDeps,
	ctx: ActionContext,
	query: VerificationQueueQuery = {}
): Promise<{ items: VerificationQueueItem[]; nextCursor: string | null }> {
	requirePermission(ctx.subject, 'company.review', { companyStatus: 'submitted' });
	const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
	const now = deps.now();
	const dueCutoff = new Date(now.getTime() - REVIEW_DUE_HOURS * 3600_000);
	// The requests of the companies within the operator's reach: a clone operator of a demo session sees those of its
	// session only (domain 19.3).
	const conditions: SQL[] = [
		isNull(companyVerifications.decision),
		eq(companies.status, 'submitted'),
		(await StaffReach.of(deps.db, ctx.subject)).rows(companies.demoSessionId)
	];
	if (query.authorityMethods && query.authorityMethods.length > 0) {
		conditions.push(inArray(companyVerifications.authorityMethod, query.authorityMethods));
	}
	if (query.registry && query.registry.length > 0) {
		const states = query.registry.filter((state) => state !== 'pending');
		const byState: SQL[] = [];
		if (states.length > 0) {
			byState.push(sql`${companyVerifications.registryCheck}->>'status' in (${sql.join(states, sql`, `)})`);
		}
		if (query.registry.includes('pending')) byState.push(isNull(companyVerifications.registryCheck));
		const either = or(...byState);
		if (either) conditions.push(either);
	}
	if (query.overdueOnly) conditions.push(lt(companyVerifications.createdAt, dueCutoff));
	if (query.cursor !== undefined) {
		const after = decodeCursor(query.cursor);
		const next = or(
			gt(companyVerifications.createdAt, after.submittedAt),
			and(eq(companyVerifications.createdAt, after.submittedAt), gt(companyVerifications.id, after.id))
		);
		if (next) conditions.push(next);
	}
	const rows = await deps.db
		.select({
			verificationId: companyVerifications.id,
			companyId: companies.id,
			inn: companies.inn,
			legalName: companies.legalName,
			displayName: companies.displayName,
			authorityMethod: companyVerifications.authorityMethod,
			evidenceFileId: companyVerifications.authorityEvidenceFileId,
			registryCheck: companyVerifications.registryCheck,
			submittedAt: companyVerifications.createdAt,
			attempt: attemptNumber()
		})
		.from(companyVerifications)
		.innerJoin(companies, eq(companies.id, companyVerifications.companyId))
		.where(and(...conditions))
		.orderBy(asc(companyVerifications.createdAt), asc(companyVerifications.id))
		.limit(limit + 1);
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return {
		items: page.map((row) => {
			const dueAt = new Date(row.submittedAt.getTime() + REVIEW_DUE_HOURS * 3600_000);
			return {
				verificationId: row.verificationId,
				companyId: row.companyId,
				inn: row.inn,
				legalName: row.legalName,
				displayName: row.displayName,
				authorityMethod: row.authorityMethod,
				hasEvidence: row.evidenceFileId !== null,
				registryCheck: parseRegistryCheck(row.registryCheck),
				submittedAt: row.submittedAt,
				dueAt,
				overdue: dueAt.getTime() <= now.getTime(),
				attempt: row.attempt
			};
		}),
		nextCursor: rows.length > limit && last ? encodeCursor(last.submittedAt, last.verificationId) : null
	};
}

/** Number of requests of the company up to and including this one. */
function attemptNumber(): SQL<number> {
	return sql<number>`(select count(*)::int from ${companyVerifications} as earlier
		where earlier.company_id = ${companyVerifications.companyId}
		and earlier.created_at <= ${companyVerifications.createdAt})`;
}

export interface VerificationCase {
	verificationId: string;
	state: 'pending' | 'approved' | 'rejected' | 'needs_info';
	company: {
		id: string;
		inn: string;
		ogrn: string | null;
		kpp: string | null;
		legalName: string;
		displayName: string;
		status: CompanyStatus;
		registrySnapshot: unknown;
	};
	applicant: { memberId: string; displayName: string | null; memberStatus: 'invited' | 'active' | 'removed' };
	authorityMethod: AuthorityMethod;
	evidence: { fileId: string; declaredName: string; detectedMime: string; sizeBytes: number } | null;
	registryCheck: RegistryCheck | null;
	submittedAt: Date;
	/** Earlier requests of the company with their decisions, newest first. */
	history: {
		verificationId: string;
		decision: 'approved' | 'rejected' | 'needs_info' | null;
		reason: string | null;
		decidedAt: Date | null;
	}[];
}

/** One request with everything the operator decides on. */
export async function verificationCase(
	deps: CompanyDeps,
	ctx: ActionContext,
	verificationId: string
): Promise<VerificationCase> {
	requirePermission(ctx.subject, 'company.review', { companyStatus: 'submitted' });
	const [row] = await deps.db
		.select({
			verification: companyVerifications,
			company: companies,
			applicantName: users.displayName,
			applicantStatus: companyMembers.status,
			file: {
				id: files.id,
				declaredName: files.declaredName,
				detectedMime: files.detectedMime,
				sizeBytes: files.sizeBytes
			}
		})
		.from(companyVerifications)
		.innerJoin(companies, eq(companies.id, companyVerifications.companyId))
		.innerJoin(companyMembers, eq(companyMembers.id, companyVerifications.applicantMemberId))
		.leftJoin(users, eq(users.id, companyMembers.userId))
		.leftJoin(files, eq(files.id, companyVerifications.authorityEvidenceFileId))
		.where(eq(companyVerifications.id, verificationId));
	if (!row) throw new ApiError('not_found');
	(await StaffReach.of(deps.db, ctx.subject)).require(row.company.demoSessionId);
	const history = await deps.db
		.select({
			verificationId: companyVerifications.id,
			decision: companyVerifications.decision,
			reason: companyVerifications.reason,
			decidedAt: companyVerifications.decidedAt
		})
		.from(companyVerifications)
		.where(and(eq(companyVerifications.companyId, row.company.id), ne(companyVerifications.id, verificationId)))
		.orderBy(desc(companyVerifications.createdAt));
	const { verification, company } = row;
	return {
		verificationId: verification.id,
		state: verification.decision ?? 'pending',
		company: {
			id: company.id,
			inn: company.inn,
			ogrn: company.ogrn,
			kpp: company.kpp,
			legalName: company.legalName,
			displayName: company.displayName,
			status: company.status,
			registrySnapshot: company.registrySnapshot
		},
		applicant: {
			memberId: verification.applicantMemberId,
			displayName: row.applicantName,
			memberStatus: row.applicantStatus
		},
		authorityMethod: verification.authorityMethod,
		evidence: row.file
			? {
					fileId: row.file.id,
					declaredName: row.file.declaredName,
					detectedMime: row.file.detectedMime,
					sizeBytes: row.file.sizeBytes
				}
			: null,
		registryCheck: parseRegistryCheck(verification.registryCheck),
		submittedAt: verification.createdAt,
		history
	};
}

export type VerificationDecision =
	| {
			kind: 'approve';
			/** Requisites the operator confirmed against the registry; omitted fields stay as the owner entered them. */
			requisites?: { legalName?: string; ogrn?: string | null; kpp?: string | null };
	  }
	| { kind: 'reject'; reason: string }
	| { kind: 'request_info'; reason: string };

function checkReason(reason: string): string {
	const trimmed = reason.trim();
	if (trimmed.length < REASON_MIN || trimmed.length > REASON_MAX) {
		throw invalid([
			{
				path: 'reason',
				code: 'invalid_length',
				message: `Причина для работодателя — от ${REASON_MIN} до ${REASON_MAX} символов`
			}
		]);
	}
	return trimmed;
}

function approvedRequisites(
	company: CompanyRow,
	requisites: NonNullable<Extract<VerificationDecision, { kind: 'approve' }>['requisites']>
): Partial<typeof companies.$inferInsert> {
	const values: Partial<typeof companies.$inferInsert> = {};
	const details: ErrorDetail[] = [];
	if (requisites.legalName !== undefined) {
		values.legalName = requisites.legalName.trim();
		if (values.legalName.length < 2 || values.legalName.length > 500) {
			details.push({
				path: 'legalName',
				code: 'invalid_length',
				message: 'Полное наименование — от 2 до 500 символов'
			});
		}
	}
	if (requisites.ogrn !== undefined) {
		values.ogrn = requisites.ogrn === null ? null : requisites.ogrn.trim();
		if (
			values.ogrn !== null &&
			(!isValidOgrn(values.ogrn) || (company.inn.length === 10) !== (values.ogrn.length === 13))
		) {
			details.push({ path: 'ogrn', code: 'invalid_ogrn', message: 'ОГРН не соответствует ИНН или контрольной цифре' });
		}
	}
	if (requisites.kpp !== undefined) {
		values.kpp = requisites.kpp === null ? null : requisites.kpp.trim().toUpperCase();
		if (values.kpp !== null && !isValidKpp(values.kpp)) {
			details.push({ path: 'kpp', code: 'invalid_kpp', message: 'КПП — 9 символов' });
		}
	}
	if (details.length > 0) throw invalid(details);
	return values;
}

async function activeOwnerCount(tx: Transaction, companyId: string): Promise<number> {
	const [row] = await tx
		.select({ n: count() })
		.from(companyMembers)
		.where(
			and(
				eq(companyMembers.companyId, companyId),
				eq(companyMembers.role, 'owner'),
				eq(companyMembers.status, 'active')
			)
		);
	return row?.n ?? 0;
}

/**
 * The operator's decision on an open request: approve (the company becomes `verified`), reject with a reason (the
 * company becomes `rejected` and frees its number) or send back for clarification with a reason (the company returns
 * to `draft`, the owner edits and submits again). The reason is the operator's message to the owner.
 */
export async function decideVerification(
	deps: CompanyDeps,
	ctx: ActionContext,
	verificationId: string,
	decision: VerificationDecision
): Promise<void> {
	requirePermission(ctx.subject, 'company.review', { companyStatus: 'submitted' });
	const operatorId = sessionUserId(ctx.subject);
	const reason = decision.kind === 'approve' ? null : checkReason(decision.reason);
	const now = deps.now();

	await deps.db.transaction(async (tx) => {
		const [verification] = await tx
			.select({
				companyId: companyVerifications.companyId,
				applicantMemberId: companyVerifications.applicantMemberId
			})
			.from(companyVerifications)
			.where(eq(companyVerifications.id, verificationId));
		if (!verification) throw new ApiError('not_found');
		// Decisions on one company are ordered by its row lock; the decision is read again under the lock.
		const company = await lockCompany(tx, verification.companyId);
		(await StaffReach.of(tx, ctx.subject)).require(company.demoSessionId);
		const [current] = await tx
			.select({ decision: companyVerifications.decision })
			.from(companyVerifications)
			.where(eq(companyVerifications.id, verificationId));
		if (current?.decision !== null || company.status !== 'submitted') {
			throw conflict('already_decided', 'По заявке уже принято решение');
		}
		const [ownMembership] = await tx
			.select({ id: companyMembers.id })
			.from(companyMembers)
			.where(
				and(
					eq(companyMembers.companyId, company.id),
					eq(companyMembers.userId, operatorId),
					ne(companyMembers.status, 'removed')
				)
			);
		if (ownMembership)
			throw new ApiError('forbidden', { message: 'Оператор не проверяет компанию, в которой состоит' });

		let companyValues: Partial<typeof companies.$inferInsert>;
		let verificationDecision: 'approved' | 'rejected' | 'needs_info';
		let action: 'company.verified' | 'company.rejected' | 'company.info_requested';
		switch (decision.kind) {
			case 'approve':
				if ((await activeOwnerCount(tx, company.id)) === 0) {
					throw conflict('no_active_owner', 'У компании нет действующего владельца — подтверждать некому');
				}
				companyValues = {
					...approvedRequisites(company, decision.requisites ?? {}),
					status: 'verified',
					verifiedAt: now
				};
				verificationDecision = 'approved';
				action = 'company.verified';
				break;
			case 'reject':
				companyValues = { status: 'rejected' };
				verificationDecision = 'rejected';
				action = 'company.rejected';
				break;
			case 'request_info':
				companyValues = { status: 'draft' };
				verificationDecision = 'needs_info';
				action = 'company.info_requested';
				break;
		}
		await tx.update(companies).set(companyValues).where(eq(companies.id, company.id));
		if (decision.kind === 'reject') {
			// A company acts before its check (domain 5.1): the rejection closes its unanswered offers at once.
			await withdrawOpenInvitations(tx, { companyId: company.id }, 'company_rejected', {
				requestId: ctx.meta.requestId,
				at: now
			});
		}
		await tx
			.update(companyVerifications)
			.set({ decision: verificationDecision, decidedBy: operatorId, decidedAt: now, reason })
			.where(eq(companyVerifications.id, verificationId));
		await recordAuditEvent(tx, {
			...audit(ctx),
			action,
			outcome: 'success',
			object: { type: 'company', id: company.id },
			details: { verification_id: verificationId }
		});
		// The applicant and every active owner learn the decision; its reason is read in the company profile.
		for (const userId of await decisionRecipients(tx, company.id, verification.applicantMemberId)) {
			await notify(tx, {
				userId,
				type: 'company.verification_decided',
				objectId: company.id,
				stage: `${verificationId}:${userId}`,
				payload: { verification_id: verificationId, decision: verificationDecision }
			});
		}
	});
}

/** Active accounts of the applicant and of the owners of the company, each once. */
async function decisionRecipients(tx: Transaction, companyId: string, applicantMemberId: string): Promise<string[]> {
	const rows = await tx
		.select({ userId: companyMembers.userId })
		.from(companyMembers)
		.where(
			and(
				eq(companyMembers.companyId, companyId),
				eq(companyMembers.status, 'active'),
				or(eq(companyMembers.id, applicantMemberId), eq(companyMembers.role, 'owner'))
			)
		);
	return [...new Set(rows.flatMap((row) => (row.userId === null ? [] : [row.userId])))];
}

export type SuspensionReason =
	'authority_revoked' | 'registry_inactive' | 'terms_violation' | 'complaint' | 'company_request';

/**
 * A working company — verified or acting without a check (`draft`, `submitted`) — `→ suspended`: the catalog, offers,
 * partner pools and API keys of the company close at once, because every request asks the admission policy
 * (domain 5.1). Hiring processes already under way stay open.
 */
export async function suspendCompany(
	deps: CompanyDeps,
	ctx: ActionContext,
	companyId: string,
	input: { reasonCode: SuspensionReason }
): Promise<void> {
	requirePermission(ctx.subject, 'company.moderate', { companyStatus: 'verified' });
	sessionUserId(ctx.subject);
	await deps.db.transaction((tx) => suspendInTransaction(tx, ctx, companyId, input, deps.now()));
}

/**
 * The suspension in the caller's transaction, for a decision that suspends the company together with its own records —
 * an upheld complaint of a candidate names itself in the journal (domain 13.14). The caller checked the permission.
 */
export async function suspendInTransaction(
	tx: Transaction,
	ctx: ActionContext,
	companyId: string,
	input: { reasonCode: SuspensionReason; complaintId?: string },
	now: Date
): Promise<void> {
	const company = await lockCompany(tx, companyId);
	(await StaffReach.of(tx, ctx.subject)).require(company.demoSessionId);
	if (!companyAdmission(company.status).admitted) {
		throw conflict('not_admitted', 'Компания уже приостановлена или её проверка отклонена');
	}
	await tx.update(companies).set({ status: 'suspended' }).where(eq(companies.id, companyId));
	// Sent and unanswered invitations close; accepted ones keep their hiring processes (domain 5.1).
	await withdrawOpenInvitations(tx, { companyId }, 'company_suspended', { requestId: ctx.meta.requestId, at: now });
	await recordAuditEvent(tx, {
		...audit(ctx),
		action: 'company.suspended',
		outcome: 'success',
		object: { type: 'company', id: companyId },
		details: {
			reason_code: input.reasonCode,
			...(input.complaintId === undefined ? {} : { complaint_id: input.complaintId })
		}
	});
}

/**
 * `suspended →` back to where the company was: `verified` for a company an operator has verified, `submitted` for one
 * with an open verification request, `draft` otherwise.
 */
export async function reinstateCompany(deps: CompanyDeps, ctx: ActionContext, companyId: string): Promise<void> {
	requirePermission(ctx.subject, 'company.moderate', { companyStatus: 'suspended' });
	sessionUserId(ctx.subject);
	await deps.db.transaction(async (tx) => {
		const company = await lockCompany(tx, companyId);
		(await StaffReach.of(tx, ctx.subject)).require(company.demoSessionId);
		if (company.status !== 'suspended') throw conflict('not_suspended', 'Компания не приостановлена');
		if ((await activeOwnerCount(tx, companyId)) === 0) {
			throw conflict('no_active_owner', 'У компании нет действующего владельца');
		}
		const [open] = await tx
			.select({ id: companyVerifications.id })
			.from(companyVerifications)
			.where(and(eq(companyVerifications.companyId, companyId), isNull(companyVerifications.decision)));
		const status = company.verifiedAt !== null ? 'verified' : open ? 'submitted' : 'draft';
		await tx.update(companies).set({ status }).where(eq(companies.id, companyId));
		await recordAuditEvent(tx, {
			...audit(ctx),
			action: status === 'verified' ? 'company.verified' : 'company.reinstated',
			outcome: 'success',
			object: { type: 'company', id: companyId },
			details: { from: 'suspended', status }
		});
	});
}
