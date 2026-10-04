// The company draft (domain 5.1): created by its first owner, edited while `draft` or `rejected`, then submitted for
// verification. Legal requisites are fixed once an operator verifies the company. The owner also accepts the offer on
// the work of minors (`minor_employment_terms`, domain 6.2, 13.1) that vacancies with `min_age` require.
import { and, desc, eq, gt, isNotNull, lte } from 'drizzle-orm';
import { recordAuditEvent } from '$lib/server/audit/record';
import { currentDocument, stillCurrent } from '$lib/server/auth/documents';
import { isValidInn } from '$lib/server/auth/inn';
import type { Executor } from '$lib/server/db';
import {
	companies,
	companyMembers,
	companyVerifications,
	documentAcceptances,
	legalDocuments
} from '$lib/server/db/schema';
import { demoSessionOfUser } from '$lib/server/demo/scope';
import type { ErrorDetail } from '$lib/server/errors/api-error';
import {
	auditActorOf,
	conflict,
	invalid,
	requirePermission,
	sessionUserId,
	type ActionContext,
	type CompanyDeps
} from './context';
import { assertMayBecomeEmployer } from './employer';
import type { CompanyStatus } from './gate';
import { innConflict, isInnTaken } from './inn-scope';
import { innKind, isValidKpp, isValidOgrn } from './requisites';
import { lockCompany } from './rows';

const NAME_MIN = 2;
const DISPLAY_NAME_MAX = 200;
const LEGAL_NAME_MAX = 500;

/** Statuses in which the owner edits the requisites; after a decision of the operator they change only by a new check. */
const EDITABLE: ReadonlySet<CompanyStatus> = new Set(['draft', 'rejected']);

const INN_MESSAGE = 'ИНН — 10 цифр для организации или 12 для ИП, с верной контрольной суммой';
const INN_TAKEN_MESSAGE = 'Компания с этим ИНН уже на платформе. Попросите её владельца пригласить вас в команду';

function checkName(details: ErrorDetail[], path: string, value: string, max: number): string {
	const trimmed = value.trim();
	if (trimmed.length < NAME_MIN || trimmed.length > max) {
		details.push({ path, code: 'invalid_length', message: `Название — от ${NAME_MIN} до ${max} символов` });
	}
	return trimmed;
}

export interface CompanyDraftInput {
	inn: string;
	displayName: string;
	/** Full name as the applicant states it; the operator confirms it against the registry. Defaults to `displayName`. */
	legalName?: string;
	/** Version of the employer terms shown on the form. */
	employerTermsId: string;
}

/**
 * Creates a draft company with the caller as its active owner. The caller must be neither a candidate nor an active
 * member of another company. Registration of an employer creates the same draft in its own transaction. The company of
 * an account of a demo session belongs to that session, and its number is taken within the session only.
 */
export async function createCompanyDraft(
	deps: CompanyDeps,
	ctx: ActionContext,
	input: CompanyDraftInput
): Promise<{ companyId: string; memberId: string }> {
	requirePermission(ctx.subject, 'company.create', null);
	const userId = sessionUserId(ctx.subject);
	const details: ErrorDetail[] = [];
	const inn = input.inn.trim();
	if (!isValidInn(inn)) details.push({ path: 'inn', code: 'invalid_inn', message: INN_MESSAGE });
	const displayName = checkName(details, 'displayName', input.displayName, DISPLAY_NAME_MAX);
	const legalName = checkName(details, 'legalName', input.legalName ?? input.displayName, LEGAL_NAME_MAX);
	if (details.length > 0) throw invalid(details);
	const now = deps.now();

	return deps.db.transaction(async (tx) => {
		await assertMayBecomeEmployer(tx, userId);
		const terms = await stillCurrent(tx, 'employer_terms', input.employerTermsId, now);
		if (!terms) {
			throw conflict(
				'document_outdated',
				'Условия для работодателя обновились — прочитайте новую редакцию и примите её ещё раз',
				'employerTermsId'
			);
		}
		const demoSessionId = await demoSessionOfUser(tx, userId);
		const [company] = await tx
			.insert(companies)
			.values({ inn, legalName, displayName, status: 'draft', demoSessionId })
			.onConflictDoNothing(innConflict(demoSessionId))
			.returning({ id: companies.id });
		if (!company) throw conflict('inn_taken', INN_TAKEN_MESSAGE, 'inn');
		const [member] = await tx
			.insert(companyMembers)
			.values({ companyId: company.id, userId, role: 'owner', status: 'active', joinedAt: now })
			.returning({ id: companyMembers.id });
		if (!member) throw new Error('owner membership not inserted');
		await tx.insert(documentAcceptances).values({
			documentId: terms.id,
			userId,
			companyId: company.id,
			acceptedAt: now,
			ip: ctx.meta.ip,
			ua: ctx.meta.userAgent
		});
		await recordAuditEvent(tx, {
			action: 'company.created',
			outcome: 'success',
			actor: { kind: 'user', userId, companyId: company.id },
			object: { type: 'company', id: company.id },
			requestId: ctx.meta.requestId,
			ip: ctx.meta.ip,
			userAgent: ctx.meta.userAgent,
			details: { inn_kind: innKind(inn) }
		});
		return { companyId: company.id, memberId: member.id };
	});
}

export interface CompanyDraftPatch {
	inn?: string;
	displayName?: string;
	legalName?: string;
	/** `null` clears the value. */
	ogrn?: string | null;
	kpp?: string | null;
}

/** Edits the requisites of a `draft` or `rejected` company; only its owner may. */
export async function updateCompanyDraft(
	deps: CompanyDeps,
	ctx: ActionContext,
	companyId: string,
	patch: CompanyDraftPatch
): Promise<void> {
	requirePermission(ctx.subject, 'company.profile.manage', { companyId });
	const details: ErrorDetail[] = [];
	const values: Partial<typeof companies.$inferInsert> = {};
	if (patch.inn !== undefined) {
		values.inn = patch.inn.trim();
		if (!isValidInn(values.inn)) details.push({ path: 'inn', code: 'invalid_inn', message: INN_MESSAGE });
	}
	if (patch.displayName !== undefined) {
		values.displayName = checkName(details, 'displayName', patch.displayName, DISPLAY_NAME_MAX);
	}
	if (patch.legalName !== undefined) {
		values.legalName = checkName(details, 'legalName', patch.legalName, LEGAL_NAME_MAX);
	}
	if (patch.ogrn !== undefined) {
		values.ogrn = patch.ogrn === null ? null : patch.ogrn.trim();
		if (values.ogrn !== null && !isValidOgrn(values.ogrn)) {
			details.push({
				path: 'ogrn',
				code: 'invalid_ogrn',
				message: 'ОГРН — 13 цифр, ОГРНИП — 15, с верной контрольной цифрой'
			});
		}
	}
	if (patch.kpp !== undefined) {
		values.kpp = patch.kpp === null ? null : patch.kpp.trim().toUpperCase();
		if (values.kpp !== null && !isValidKpp(values.kpp)) {
			details.push({
				path: 'kpp',
				code: 'invalid_kpp',
				message: 'КПП — 9 символов: 4 цифры, 2 цифры или буквы, 3 цифры'
			});
		}
	}
	if (details.length > 0) throw invalid(details);
	const fields = Object.keys(values);
	if (fields.length === 0) return;

	try {
		await deps.db.transaction(async (tx) => {
			const company = await lockCompany(tx, companyId);
			if (!EDITABLE.has(company.status)) {
				throw conflict('company_locked', 'Реквизиты проверенной или проверяемой компании не редактируются');
			}
			const inn = values.inn ?? company.inn;
			const ogrn = values.ogrn === undefined ? company.ogrn : values.ogrn;
			if (ogrn !== null && (inn.length === 10) !== (ogrn.length === 13)) {
				throw invalid([
					{
						path: 'ogrn',
						code: 'ogrn_kind_mismatch',
						message: 'ОГРН организации — 13 цифр, ОГРНИП предпринимателя — 15'
					}
				]);
			}
			await tx.update(companies).set(values).where(eq(companies.id, companyId));
			await recordAuditEvent(tx, {
				action: 'company.updated',
				outcome: 'success',
				actor: auditActorOf(ctx.subject),
				object: { type: 'company', id: companyId },
				requestId: ctx.meta.requestId,
				ip: ctx.meta.ip,
				userAgent: ctx.meta.userAgent,
				details: { fields }
			});
		});
	} catch (error) {
		if (isInnTaken(error)) throw conflict('inn_taken', INN_TAKEN_MESSAGE, 'inn');
		throw error;
	}
}

export interface CompanyOverview {
	id: string;
	inn: string;
	ogrn: string | null;
	kpp: string | null;
	legalName: string;
	displayName: string;
	status: CompanyStatus;
	verifiedAt: Date | null;
	/** The last verification request and its outcome; the reason is the operator's message to the owner. */
	verification: {
		id: string;
		state: 'pending' | 'approved' | 'rejected' | 'needs_info';
		reason: string | null;
		submittedAt: Date;
		decidedAt: Date | null;
	} | null;
}

/** The company as its owner sees it, with the state of its verification. */
export async function companyOverview(
	deps: CompanyDeps,
	ctx: ActionContext,
	companyId: string
): Promise<CompanyOverview> {
	requirePermission(ctx.subject, 'company.profile.manage', { companyId });
	const [company] = await deps.db.select().from(companies).where(eq(companies.id, companyId));
	if (!company) throw new Error(`company ${companyId} of an active membership does not exist`);
	const [last] = await deps.db
		.select({
			id: companyVerifications.id,
			decision: companyVerifications.decision,
			reason: companyVerifications.reason,
			submittedAt: companyVerifications.createdAt,
			decidedAt: companyVerifications.decidedAt
		})
		.from(companyVerifications)
		.where(eq(companyVerifications.companyId, companyId))
		.orderBy(desc(companyVerifications.createdAt), desc(companyVerifications.id))
		.limit(1);
	return {
		id: company.id,
		inn: company.inn,
		ogrn: company.ogrn,
		kpp: company.kpp,
		legalName: company.legalName,
		displayName: company.displayName,
		status: company.status,
		verifiedAt: company.verifiedAt,
		verification: last
			? {
					id: last.id,
					state: last.decision ?? 'pending',
					reason: last.decision === 'approved' ? null : last.reason,
					submittedAt: last.submittedAt,
					decidedAt: last.decidedAt
				}
			: null
	};
}

export interface MinorTermsAcceptance {
	/** `document_acceptances.id`: what a vacancy with `min_age` refers to. */
	id: string;
	documentId: string;
	version: number;
	acceptedAt: Date;
}

/**
 * The acceptance of `minor_employment_terms` by the company that is in effect at `now`: its latest accepted version,
 * unless a later published version asks to accept again. `null` — the company has not accepted the offer, or has to
 * accept its new version.
 */
export async function minorTermsAcceptance(
	executor: Executor,
	companyId: string,
	now: Date
): Promise<MinorTermsAcceptance | null> {
	const [accepted] = await executor
		.select({
			id: documentAcceptances.id,
			documentId: documentAcceptances.documentId,
			version: legalDocuments.version,
			acceptedAt: documentAcceptances.acceptedAt
		})
		.from(documentAcceptances)
		.innerJoin(legalDocuments, eq(legalDocuments.id, documentAcceptances.documentId))
		.where(
			and(
				eq(documentAcceptances.companyId, companyId),
				eq(legalDocuments.kind, 'minor_employment_terms'),
				lte(documentAcceptances.acceptedAt, now)
			)
		)
		.orderBy(desc(legalDocuments.version), desc(documentAcceptances.acceptedAt))
		.limit(1);
	if (!accepted) return null;
	const [reconsent] = await executor
		.select({ id: legalDocuments.id })
		.from(legalDocuments)
		.where(
			and(
				eq(legalDocuments.kind, 'minor_employment_terms'),
				eq(legalDocuments.requiresReconsent, true),
				isNotNull(legalDocuments.publishedAt),
				lte(legalDocuments.publishedAt, now),
				gt(legalDocuments.version, accepted.version)
			)
		)
		.limit(1);
	return reconsent ? null : accepted;
}

export interface MinorTermsView {
	/** The acceptance in effect; `null` — vacancies for minors cannot be saved until the owner accepts. */
	accepted: { version: number; acceptedAt: Date } | null;
	/** The current published version to accept; `null` when none is published. */
	current: { id: string; version: number; title: string } | null;
}

/** The offer on the work of minors as the owner sees it in the profile. */
export async function minorTermsOf(deps: CompanyDeps, ctx: ActionContext, companyId: string): Promise<MinorTermsView> {
	requirePermission(ctx.subject, 'company.profile.manage', { companyId });
	const now = deps.now();
	const [accepted, current] = await Promise.all([
		minorTermsAcceptance(deps.db, companyId, now),
		currentDocument(deps.db, 'minor_employment_terms', now)
	]);
	return {
		accepted: accepted && { version: accepted.version, acceptedAt: accepted.acceptedAt },
		current: current && { id: current.id, version: current.version, title: current.title }
	};
}

/**
 * The owner accepts the version of `minor_employment_terms` the profile showed. The acceptance is recorded with the
 * request's address and client, as every acceptance of a document; the company refers to the version it accepted.
 */
export async function acceptMinorTerms(
	deps: CompanyDeps,
	ctx: ActionContext,
	companyId: string,
	documentId: string
): Promise<MinorTermsAcceptance> {
	requirePermission(ctx.subject, 'company.profile.manage', { companyId });
	const userId = sessionUserId(ctx.subject);
	const now = deps.now();
	return deps.db.transaction(async (tx) => {
		await lockCompany(tx, companyId);
		const document = await stillCurrent(tx, 'minor_employment_terms', documentId, now);
		if (!document) {
			throw conflict(
				'document_outdated',
				'Оферта обновилась — прочитайте новую редакцию и примите её ещё раз',
				'documentId'
			);
		}
		const [acceptance] = await tx
			.insert(documentAcceptances)
			.values({ documentId: document.id, userId, companyId, acceptedAt: now, ip: ctx.meta.ip, ua: ctx.meta.userAgent })
			.returning({ id: documentAcceptances.id });
		if (!acceptance) throw new Error('acceptance not inserted');
		await tx.update(companies).set({ minorTermsDocumentId: document.id }).where(eq(companies.id, companyId));
		await recordAuditEvent(tx, {
			action: 'company.updated',
			outcome: 'success',
			actor: auditActorOf(ctx.subject),
			object: { type: 'company', id: companyId },
			requestId: ctx.meta.requestId,
			ip: ctx.meta.ip,
			userAgent: ctx.meta.userAgent,
			details: {
				fields: ['minor_terms_document_id'],
				document_acceptance_id: acceptance.id,
				document_version: document.version
			}
		});
		return { id: acceptance.id, documentId: document.id, version: document.version, acceptedAt: now };
	});
}
