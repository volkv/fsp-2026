// Authority of a legal representative of a candidate aged 14–17 (docs/domain.md 6.4; part 1 of article 9 of 152-FZ):
// a confirmed address proves only that the representative owns it, so the profile opens only after an FSP operator
// checks the authority and records how and on what minimal basis. A copy of the document is one of the ways, never a
// requirement: a document presented at a meeting or a video call is as valid, and no copy is kept then.
//
// The representative's own choice of the way (`contact_confirmed → authority_pending`) has no screen yet, so the
// operator decides from either state and records the way the check actually took.
//
// The operator works the representations within its reach: a clone operator of a demo session — those of its session
// only (domain 19.3).
import { and, asc, desc, eq, inArray, lte, ne } from 'drizzle-orm';
import { z } from 'zod';
import { StaffReach } from '$lib/server/access/demo-actor';
import type { AccessSubject } from '$lib/server/access/permissions';
import { recordAuditEvent } from '$lib/server/audit/record';
import type { RequestMeta } from '$lib/server/auth/context';
import { auditActorOf, conflict, invalid, requirePermission, sessionUserId } from '$lib/server/companies/context';
import { parsePolicyParams, type PolicyParams } from '$lib/server/consent/kinds';
import type { FieldCrypto } from '$lib/server/crypto/fields';
import type { Database, Executor } from '$lib/server/db';
import {
	authorityChecks,
	candidates,
	files,
	legalRepresentatives,
	productPolicies,
	representations,
	users
} from '$lib/server/db/schema';
import { ApiError, type ErrorDetail } from '$lib/server/errors/api-error';
import { notify } from '$lib/server/notifications/notify';
import { ageBand, isMinorBand, type AgeBand } from '$lib/server/visibility/age';

export type RepresentationStatus = (typeof representations.$inferSelect)['status'];
export type RepresentationRelation = (typeof representations.$inferSelect)['relation'];
export type AuthorityBasis = (typeof authorityChecks.$inferSelect)['basisKind'];

/** Statuses waiting for the operator: the address is confirmed, the authority is not checked yet. */
const AWAITING: readonly RepresentationStatus[] = ['contact_confirmed', 'authority_pending'];

/**
 * Ways the operator records by itself. `document_upload` needs a copy uploaded by the representative, which has no
 * upload path yet; `esia` is on the roadmap (policies/minor_policy.json).
 */
export const OPERATOR_AUTHORITY_METHODS = ['document_presented', 'in_person'] as const;
export type OperatorAuthorityMethod = (typeof OPERATOR_AUTHORITY_METHODS)[number];

export const AUTHORITY_BASES: readonly AuthorityBasis[] = [
	'birth_certificate',
	'adoption_decision',
	'guardianship_act',
	'custodianship_act'
];

const NOTE_MAX = 500;
/** A run of digits looks like a document number or requisites, which the check never stores. */
const DOCUMENT_NUMBER = /\d[\d\s-]{3,}\d/;

export interface RepresentationQueueItem {
	id: string;
	status: RepresentationStatus;
	relation: RepresentationRelation;
	invitedAt: Date;
	contactConfirmedAt: Date | null;
	age: AgeBand;
}

/** Representations waiting for the authority check, the longest waiting first. */
export async function representationQueue(
	executor: Executor,
	subject: AccessSubject,
	now: Date
): Promise<RepresentationQueueItem[]> {
	requirePermission(subject, 'representation.review', null);
	const rows = await executor
		.select({
			id: representations.id,
			status: representations.status,
			relation: representations.relation,
			invitedAt: representations.invitedAt,
			contactConfirmedAt: representations.contactConfirmedAt,
			birthDate: candidates.birthDate,
			precision: candidates.birthDatePrecision,
			birthStatus: candidates.birthDateStatus
		})
		.from(representations)
		.innerJoin(candidates, eq(candidates.id, representations.candidateId))
		.where(
			and(
				inArray(representations.status, [...AWAITING]),
				(await StaffReach.of(executor, subject)).rows(candidates.demoSessionId)
			)
		)
		.orderBy(asc(representations.contactConfirmedAt), asc(representations.id));
	return rows.map((row) => ({
		id: row.id,
		status: row.status,
		relation: row.relation,
		invitedAt: row.invitedAt,
		contactConfirmedAt: row.contactConfirmedAt,
		age: ageBand({ birthDate: row.birthDate, precision: row.precision, status: row.birthStatus }, now)
	}));
}

/** The `minor_policy` in force: whether minors are served at all and which ways of the check are allowed. */
async function minorPolicy(executor: Executor, now: Date): Promise<PolicyParams<'minor_policy'> | null> {
	const [row] = await executor
		.select({ params: productPolicies.params })
		.from(productPolicies)
		.where(and(eq(productPolicies.kind, 'minor_policy'), lte(productPolicies.effectiveFrom, now)))
		.orderBy(desc(productPolicies.effectiveFrom), desc(productPolicies.version))
		.limit(1);
	return row ? parsePolicyParams('minor_policy', row.params) : null;
}

export interface RepresentationCase {
	id: string;
	status: RepresentationStatus;
	relation: RepresentationRelation;
	invitedAt: Date;
	contactConfirmedAt: Date | null;
	endedAt: Date | null;
	endReason: string | null;
	representative: { fullName: string; email: string; phone: string | null };
	candidate: {
		displayName: string | null;
		birthDate: string | null;
		birthDatePrecision: string | null;
		birthDateStatus: string;
		age: AgeBand;
	};
	/** Ways of the check the operator may record now: those of the policy in force that need no stored copy. */
	methods: OperatorAuthorityMethod[];
	checks: {
		method: string;
		basisKind: AuthorityBasis;
		basisNote: string | null;
		result: 'verified' | 'rejected';
		checkedAt: Date;
		checkedByName: string | null;
		note: string | null;
		/** The copy of the document kept with a `document_upload` check, until its own retention date. */
		evidence: { fileId: string; declaredName: string } | null;
	}[];
}

/**
 * The case of one representation with the contacts of the representative and the candidate's age: the operator calls
 * or meets the representative and compares the document with them. Every opening is `operator.case_access`.
 */
export async function representationCase(
	db: Database,
	crypto: FieldCrypto,
	subject: AccessSubject,
	meta: RequestMeta,
	representationId: string,
	now: Date
): Promise<RepresentationCase> {
	requirePermission(subject, 'representation.review', null);
	if (!z.uuid().safeParse(representationId).success) throw new ApiError('not_found');
	const [row] = await db
		.select({
			representation: representations,
			representative: legalRepresentatives,
			displayName: users.displayName,
			birthDate: candidates.birthDate,
			precision: candidates.birthDatePrecision,
			birthStatus: candidates.birthDateStatus,
			demoSessionId: candidates.demoSessionId
		})
		.from(representations)
		.innerJoin(legalRepresentatives, eq(legalRepresentatives.id, representations.representativeId))
		.innerJoin(candidates, eq(candidates.id, representations.candidateId))
		.innerJoin(users, eq(users.id, candidates.userId))
		.where(eq(representations.id, representationId));
	if (!row) throw new ApiError('not_found');
	(await StaffReach.of(db, subject)).require(row.demoSessionId);
	const checks = await db
		.select({
			method: authorityChecks.method,
			basisKind: authorityChecks.basisKind,
			basisNote: authorityChecks.basisNote,
			result: authorityChecks.result,
			checkedAt: authorityChecks.checkedAt,
			checkedByName: users.displayName,
			note: authorityChecks.note,
			evidenceFileId: files.id,
			evidenceName: files.declaredName
		})
		.from(authorityChecks)
		.leftJoin(users, eq(users.id, authorityChecks.checkedBy))
		.leftJoin(files, and(eq(files.id, authorityChecks.evidenceFileId), ne(files.status, 'deleted')))
		.where(eq(authorityChecks.representationId, representationId))
		.orderBy(desc(authorityChecks.checkedAt));
	const policy = await minorPolicy(db, now);
	const { representation, representative } = row;
	await recordAuditEvent(db, {
		action: 'operator.case_access',
		outcome: 'success',
		actor: auditActorOf(subject),
		object: { type: 'representation', id: representation.id },
		subjectCandidateId: representation.candidateId,
		requestId: meta.requestId,
		ip: meta.ip,
		userAgent: meta.userAgent,
		details: { case_type: 'authority', case_id: representation.id }
	});
	return {
		id: representation.id,
		status: representation.status,
		relation: representation.relation,
		invitedAt: representation.invitedAt,
		contactConfirmedAt: representation.contactConfirmedAt,
		endedAt: representation.endedAt,
		endReason: representation.endReason,
		representative: {
			fullName: crypto.decrypt(representative.fullNameEnc, 'legal_representatives.full_name'),
			email: crypto.decrypt(representative.emailEnc, 'legal_representatives.email'),
			phone: representative.phoneEnc ? crypto.decrypt(representative.phoneEnc, 'legal_representatives.phone') : null
		},
		candidate: {
			displayName: row.displayName,
			birthDate: row.birthDate,
			birthDatePrecision: row.precision,
			birthDateStatus: row.birthStatus,
			age: ageBand({ birthDate: row.birthDate, precision: row.precision, status: row.birthStatus }, now)
		},
		methods: policy?.enabled
			? OPERATOR_AUTHORITY_METHODS.filter((method) => policy.authority_methods.includes(method))
			: [],
		checks: checks.map(({ evidenceFileId, evidenceName, ...check }) => ({
			...check,
			evidence:
				evidenceFileId !== null && evidenceName !== null ? { fileId: evidenceFileId, declaredName: evidenceName } : null
		}))
	};
}

export interface AuthorityDecision {
	result: 'verified' | 'rejected';
	method: OperatorAuthorityMethod;
	basisKind: AuthorityBasis;
	/** What was compared, without numbers or requisites of the document. */
	basisNote: string;
	/** Internal note of the operator; required for a refusal. */
	note: string;
}

function checkedText(value: string, path: string, required: boolean, problems: ErrorDetail[]): string | null {
	const text = value.trim();
	if (text === '') {
		if (required) problems.push({ path, code: 'required', message: 'Укажите причину отказа' });
		return null;
	}
	if (text.length > NOTE_MAX) {
		problems.push({ path, code: 'invalid_length', message: `Не длиннее ${NOTE_MAX} символов` });
	} else if (DOCUMENT_NUMBER.test(text)) {
		problems.push({
			path,
			code: 'document_number',
			message: 'Не записывайте номера и реквизиты документа — только что сверено'
		});
	}
	return text;
}

/**
 * The operator's decision on the authority. `verified` opens the profile of the minor (consents signed by this
 * representative count from now on) — after the commit the caller sends the representative the letter with the
 * consents to sign (`sendConsentLetter`, `$lib/server/consent/representative`), since the representative has no
 * account; `rejected` ends the representation with `authority_rejected`. A representative signs consents only after
 * verification, so a refused one leaves no consent to lapse.
 */
export async function decideAuthority(
	db: Database,
	subject: AccessSubject,
	meta: RequestMeta,
	representationId: string,
	decision: AuthorityDecision,
	now: Date
): Promise<void> {
	requirePermission(subject, 'representation.review', null);
	const operatorId = sessionUserId(subject);
	const problems: ErrorDetail[] = [];
	if (!OPERATOR_AUTHORITY_METHODS.includes(decision.method)) {
		problems.push({ path: 'method', code: 'invalid', message: 'Выберите способ проверки' });
	}
	if (!AUTHORITY_BASES.includes(decision.basisKind)) {
		problems.push({ path: 'basisKind', code: 'invalid', message: 'Выберите основание полномочий' });
	}
	const basisNote = checkedText(decision.basisNote, 'basisNote', false, problems);
	const note = checkedText(decision.note, 'note', decision.result === 'rejected', problems);
	if (problems.length > 0) throw invalid(problems);
	if (!z.uuid().safeParse(representationId).success) throw new ApiError('not_found');
	const reach = await StaffReach.of(db, subject);

	await db.transaction(async (tx) => {
		const policy = await minorPolicy(tx, now);
		if (!policy?.enabled || !policy.authority_methods.includes(decision.method)) {
			throw conflict('method_not_allowed', 'Этот способ проверки не разрешён действующей политикой', 'method');
		}
		const [representation] = await tx
			.select()
			.from(representations)
			.where(eq(representations.id, representationId))
			.for('update');
		if (!representation) throw new ApiError('not_found');
		if (!AWAITING.includes(representation.status)) {
			throw conflict('already_decided', 'Полномочия уже проверены или связь завершена');
		}
		const [candidate] = await tx
			.select({
				birthDate: candidates.birthDate,
				precision: candidates.birthDatePrecision,
				birthStatus: candidates.birthDateStatus,
				status: candidates.status,
				userId: candidates.userId,
				demoSessionId: candidates.demoSessionId
			})
			.from(candidates)
			.where(eq(candidates.id, representation.candidateId))
			.for('share');
		if (!candidate) throw new Error(`candidate ${representation.candidateId} of a representation is missing`);
		reach.require(candidate.demoSessionId);
		const band = ageBand(
			{ birthDate: candidate.birthDate, precision: candidate.precision, status: candidate.birthStatus },
			now
		);
		if (decision.result === 'verified' && !isMinorBand(band)) {
			throw conflict('not_minor', 'Кандидату не 14–17 лет: представитель не нужен');
		}
		if (candidate.status === 'deletion_pending' || candidate.status === 'deleted') {
			throw conflict('candidate_deleted', 'Кандидат удаляет профиль');
		}
		const [check] = await tx
			.insert(authorityChecks)
			.values({
				representationId,
				method: decision.method,
				basisKind: decision.basisKind,
				basisNote,
				checkedBy: operatorId,
				checkedAt: now,
				result: decision.result,
				note
			})
			.returning({ id: authorityChecks.id });
		if (!check) throw new Error('authority check was not inserted');
		await tx
			.update(representations)
			.set(
				decision.result === 'verified'
					? { status: 'authority_verified' }
					: { status: 'ended', endedAt: now, endReason: 'authority_rejected' }
			)
			.where(eq(representations.id, representationId));
		const journal = {
			actor: auditActorOf(subject),
			object: { type: 'representation', id: representationId },
			subjectCandidateId: representation.candidateId,
			requestId: meta.requestId,
			ip: meta.ip,
			userAgent: meta.userAgent,
			occurredAt: now
		};
		await recordAuditEvent(tx, {
			...journal,
			action: 'representation.authority_checked',
			outcome: 'success',
			details: {
				authority_check_id: check.id,
				result: decision.result,
				method: decision.method,
				basis_kind: decision.basisKind
			}
		});
		if (decision.result === 'rejected') {
			await recordAuditEvent(tx, {
				...journal,
				action: 'representation.ended',
				outcome: 'success',
				details: { end_reason: 'authority_rejected' }
			});
		}
		// The representative has no account on the platform (domain 6.4): the candidate is the one told. The notification
		// carries the result only — the operator's note, the way and the basis of the check stay in the case.
		await notify(tx, {
			userId: candidate.userId,
			type: 'representation.decided',
			objectId: representationId,
			payload: { representation_id: representationId, result: decision.result }
		});
	});
}
