// Conflicts of the birth date (docs/domain.md 7.2): the year the FSP states for a linked athlete disagrees with the
// date the candidate declared, the profile is closed (`ageBand` is `unknown`) and waits for an FSP operator. The
// operator checks an identity document with the person, records how and by which document — never its number — and
// the date the document shows. The date becomes `verified` with the source `operator_document`, and the regime of
// age follows from it at once:
// - 18 and older — the adult regime; consents signed while the declared date made the person a minor stop acting by
//   the rule of `effectiveConsent`, and the daily majority transition records their lapse and ends the representation;
// - 14–17 — the protected regime: consents need a representative with verified authority, and without one the
//   profile leaves the catalog;
// - under 14, or 14–17 while the minor policy is off — no profile may be kept at that age; that outcome is refused
//   here and the conflict stays open with the profile closed (a profile in use cannot become `ineligible_age`).
//
// The candidate learns the regime that follows (`candidate.age_verified`), never the date or the document.
//
// The operator works the candidates within its reach: a clone operator of a demo session — those of its session only
// (domain 19.3).
import { and, count, desc, eq, inArray, max, ne } from 'drizzle-orm';
import { z } from 'zod';
import { StaffReach } from '$lib/server/access/demo-actor';
import type { AccessSubject } from '$lib/server/access/permissions';
import { AGE_CHECK_METHODS, AGE_DOCUMENT_KINDS } from '$lib/server/audit/events';
import { recordAuditEvent } from '$lib/server/audit/record';
import { decideAge, minorsAllowed, parseBirthDate } from '$lib/server/auth/age';
import type { RequestMeta } from '$lib/server/auth/context';
import { recordProfileChange } from '$lib/server/candidates/settings';
import { auditActorOf, conflict, invalid, requirePermission, sessionUserId } from '$lib/server/companies/context';
import type { FieldCrypto } from '$lib/server/crypto/fields';
import type { Database, Executor } from '$lib/server/db';
import { athleteLinks, auditEvents, candidates, representations, users } from '$lib/server/db/schema';
import { ApiError, type ErrorDetail } from '$lib/server/errors/api-error';
import { notify } from '$lib/server/notifications/notify';
import { ageBand, isMinorBand } from '$lib/server/visibility/age';

export type AgeCheckMethod = (typeof AGE_CHECK_METHODS)[number];
export type AgeDocumentKind = (typeof AGE_DOCUMENT_KINDS)[number];
export { AGE_CHECK_METHODS, AGE_DOCUMENT_KINDS };

type BirthPrecision = 'day' | 'year';

export interface AgeConflictItem {
	candidateId: string;
	/** When the source reported the disagreeing year; `null` — the journal no longer keeps the event. */
	openedAt: Date | null;
	/** How precise the declared date is; the date itself is shown only in the case. */
	declaredPrecision: BirthPrecision | null;
}

/** When each candidate's conflict was opened: the latest `age.conflict` of the journal. */
async function conflictOpenedAt(executor: Executor, candidateIds: string[]): Promise<Map<string, Date>> {
	if (candidateIds.length === 0) return new Map();
	const rows = await executor
		.select({ candidateId: auditEvents.subjectCandidateId, at: max(auditEvents.occurredAt) })
		.from(auditEvents)
		.where(and(eq(auditEvents.action, 'age.conflict'), inArray(auditEvents.subjectCandidateId, candidateIds)))
		.groupBy(auditEvents.subjectCandidateId);
	const opened = new Map<string, Date>();
	for (const row of rows) if (row.candidateId !== null && row.at !== null) opened.set(row.candidateId, row.at);
	return opened;
}

/** A profile in use closed by a conflict of the birth date, within the operator's reach: a case of the queue. */
async function openConflict(executor: Executor, subject: AccessSubject) {
	return and(
		eq(candidates.birthDateStatus, 'conflict'),
		eq(candidates.status, 'active'),
		(await StaffReach.of(executor, subject)).rows(candidates.demoSessionId)
	);
}

/** How many cases the queue holds, for the first screen of the cabinet. */
export async function ageConflictCount(executor: Executor, subject: AccessSubject): Promise<number> {
	requirePermission(subject, 'age.review', null);
	const [row] = await executor
		.select({ n: count() })
		.from(candidates)
		.where(await openConflict(executor, subject));
	return row?.n ?? 0;
}

/** Profiles closed by a conflict of the birth date, the longest waiting first. */
export async function ageConflictQueue(executor: Executor, subject: AccessSubject): Promise<AgeConflictItem[]> {
	requirePermission(subject, 'age.review', null);
	const rows = await executor
		.select({ candidateId: candidates.id, precision: candidates.birthDatePrecision })
		.from(candidates)
		.where(await openConflict(executor, subject));
	const opened = await conflictOpenedAt(
		executor,
		rows.map((row) => row.candidateId)
	);
	return rows
		.map((row) => ({
			candidateId: row.candidateId,
			openedAt: opened.get(row.candidateId) ?? null,
			declaredPrecision: row.precision
		}))
		.sort(
			(a, b) =>
				(a.openedAt?.getTime() ?? 0) - (b.openedAt?.getTime() ?? 0) || a.candidateId.localeCompare(b.candidateId)
		);
}

export interface AgeCase {
	candidateId: string;
	/** Whether the conflict is still open; a decided case shows its result. */
	status: 'conflict' | 'unverified' | 'verified' | 'unknown';
	openedAt: Date | null;
	/** The name to compare with the document and the address to arrange the check. */
	person: { fullName: string | null; displayName: string | null; email: string | null };
	declared: { birthDate: string | null; precision: BirthPrecision | null; source: string | null };
	/** The FSP athlete whose record gave the disagreeing year, to look it up in the federation's registry. */
	fspAthleteId: string | null;
	verifiedAt: Date | null;
	/** The representation of a minor that is not ended, if any: the protected regime needs a verified one. */
	representation: { status: string } | null;
	minorsAllowed: boolean;
}

/**
 * The case of one candidate's birth date with the name and the address of the person: the operator arranges the
 * check and compares the document with them. Every opening is `operator.case_access`.
 */
export async function ageCase(
	db: Database,
	crypto: FieldCrypto,
	subject: AccessSubject,
	meta: RequestMeta,
	candidateId: string,
	now: Date
): Promise<AgeCase> {
	requirePermission(subject, 'age.review', null);
	if (!z.uuid().safeParse(candidateId).success) throw new ApiError('not_found');
	const [row] = await db
		.select({
			candidate: {
				id: candidates.id,
				status: candidates.status,
				userId: candidates.userId,
				lastNameEnc: candidates.lastNameEnc,
				firstNameEnc: candidates.firstNameEnc,
				middleNameEnc: candidates.middleNameEnc,
				birthDate: candidates.birthDate,
				precision: candidates.birthDatePrecision,
				source: candidates.birthDateSource,
				birthStatus: candidates.birthDateStatus,
				verifiedAt: candidates.birthDateVerifiedAt,
				demoSessionId: candidates.demoSessionId
			},
			displayName: users.displayName,
			emailEnc: users.emailEnc
		})
		.from(candidates)
		.innerJoin(users, eq(users.id, candidates.userId))
		.where(eq(candidates.id, candidateId));
	if (!row) throw new ApiError('not_found');
	(await StaffReach.of(db, subject)).require(row.candidate.demoSessionId);
	const { candidate } = row;
	// A case is one that was opened by a conflict: a profile that never had one is not a case of this queue.
	const opened = (await conflictOpenedAt(db, [candidate.id])).get(candidate.id) ?? null;
	if (candidate.birthStatus !== 'conflict' && opened === null) throw new ApiError('not_found');

	const [link] = await db
		.select({ sourceAthleteId: athleteLinks.sourceAthleteId })
		.from(athleteLinks)
		.where(and(eq(athleteLinks.userId, candidate.userId), eq(athleteLinks.source, 'fsp')))
		.orderBy(desc(athleteLinks.linkedAt))
		.limit(1);
	const [representation] = await db
		.select({ status: representations.status })
		.from(representations)
		.where(and(eq(representations.candidateId, candidate.id), ne(representations.status, 'ended')))
		.orderBy(desc(representations.invitedAt))
		.limit(1);

	await recordAuditEvent(db, {
		action: 'operator.case_access',
		outcome: 'success',
		actor: auditActorOf(subject),
		object: { type: 'candidate', id: candidate.id },
		subjectCandidateId: candidate.id,
		requestId: meta.requestId,
		ip: meta.ip,
		userAgent: meta.userAgent,
		details: { case_type: 'age', case_id: candidate.id }
	});
	const open = (
		value: Uint8Array | null,
		context: 'candidates.last_name' | 'candidates.first_name' | 'candidates.middle_name'
	) => (value === null ? null : crypto.decrypt(value, context));
	const fullName = [
		open(candidate.lastNameEnc, 'candidates.last_name'),
		open(candidate.firstNameEnc, 'candidates.first_name'),
		open(candidate.middleNameEnc, 'candidates.middle_name')
	]
		.filter((part): part is string => part !== null && part.length > 0)
		.join(' ');
	return {
		candidateId: candidate.id,
		status: candidate.birthStatus,
		openedAt: opened,
		person: {
			fullName: fullName.length > 0 ? fullName : null,
			displayName: row.displayName,
			email: row.emailEnc === null ? null : crypto.decrypt(row.emailEnc, 'users.email')
		},
		declared: { birthDate: candidate.birthDate, precision: candidate.precision, source: candidate.source },
		fspAthleteId: link?.sourceAthleteId ?? null,
		verifiedAt: candidate.verifiedAt,
		representation: representation ?? null,
		minorsAllowed: await minorsAllowed(db, now)
	};
}

export interface AgeDecisionInput {
	/** The date of birth the document shows, `YYYY-MM-DD`. */
	birthDate: string;
	method: AgeCheckMethod;
	documentKind: AgeDocumentKind;
}

export interface AgeDecisionOutcome {
	regime: 'adult' | 'minor';
	matchesDeclared: boolean;
	/** The profile of a minor without a verified representative left the catalog. */
	hidden: boolean;
}

/**
 * The operator's decision on a conflict of the birth date: the date of the document becomes the verified date of the
 * profile, `age.verified` records the way, the document kind and the regime. A decided conflict is `409
 * not_in_conflict`; an age at which no profile may be kept is `409 ineligible_age` and changes nothing.
 */
export async function resolveAgeConflict(
	db: Database,
	subject: AccessSubject,
	meta: RequestMeta,
	candidateId: string,
	input: AgeDecisionInput,
	now: Date
): Promise<AgeDecisionOutcome> {
	requirePermission(subject, 'age.review', null);
	const operatorId = sessionUserId(subject);
	const problems: ErrorDetail[] = [];
	const birthDate = parseBirthDate(input.birthDate, now);
	if (birthDate === null) {
		problems.push({ path: 'birthDate', code: 'invalid', message: 'Укажите дату рождения из документа' });
	}
	if (!AGE_CHECK_METHODS.includes(input.method)) {
		problems.push({ path: 'method', code: 'invalid', message: 'Выберите способ проверки' });
	}
	if (!AGE_DOCUMENT_KINDS.includes(input.documentKind)) {
		problems.push({ path: 'documentKind', code: 'invalid', message: 'Выберите документ' });
	}
	if (problems.length > 0 || birthDate === null) throw invalid(problems);
	if (!z.uuid().safeParse(candidateId).success) throw new ApiError('not_found');
	const reach = await StaffReach.of(db, subject);

	return db.transaction(async (tx) => {
		const [candidate] = await tx
			.select({
				userId: candidates.userId,
				status: candidates.status,
				birthDate: candidates.birthDate,
				birthStatus: candidates.birthDateStatus,
				visibility: candidates.visibility,
				demoSessionId: candidates.demoSessionId
			})
			.from(candidates)
			.where(eq(candidates.id, candidateId))
			.for('update');
		if (!candidate) throw new ApiError('not_found');
		reach.require(candidate.demoSessionId);
		if (candidate.birthStatus !== 'conflict') {
			throw conflict('not_in_conflict', 'Расхождения по дате рождения уже нет: решение принято или дата изменилась');
		}
		if (candidate.status !== 'active') throw conflict('candidate_not_active', 'Профиль кандидата удаляется');
		const age = decideAge(birthDate, now, await minorsAllowed(tx, now));
		if (age.kind === 'ineligible') {
			throw conflict(
				'ineligible_age',
				'По документу профиль в этом возрасте вести нельзя: решение этим путём не записывается, профиль остаётся закрытым',
				'birthDate'
			);
		}
		await tx
			.update(candidates)
			.set({
				birthDate,
				birthDatePrecision: 'day',
				birthDateSource: 'operator_document',
				birthDateStatus: 'verified',
				birthDateVerifiedBy: operatorId,
				birthDateVerifiedAt: now
			})
			.where(eq(candidates.id, candidateId));
		const band = ageBand({ birthDate, precision: 'day', status: 'verified' }, now);
		const minor = isMinorBand(band);
		let hidden = false;
		if (minor && candidate.visibility === 'catalog') {
			const [verified] = await tx
				.select({ id: representations.id })
				.from(representations)
				.where(and(eq(representations.candidateId, candidateId), eq(representations.status, 'authority_verified')))
				.limit(1);
			if (!verified) {
				await tx.update(candidates).set({ visibility: 'hidden' }).where(eq(candidates.id, candidateId));
				hidden = true;
			}
		}
		// The regime changes who sees the profile and which vacancies match it: the counters and matches are recomputed.
		await recordProfileChange(tx, candidateId, {
			categorizationInput: false,
			createdBy: { kind: 'user', id: operatorId }
		});
		const outcome: AgeDecisionOutcome = {
			regime: minor ? 'minor' : 'adult',
			matchesDeclared: candidate.birthDate === birthDate,
			hidden
		};
		await recordAuditEvent(tx, {
			action: 'age.verified',
			outcome: 'success',
			actor: auditActorOf(subject),
			object: { type: 'candidate', id: candidateId },
			subjectCandidateId: candidateId,
			requestId: meta.requestId,
			ip: meta.ip,
			userAgent: meta.userAgent,
			occurredAt: now,
			details: {
				method: input.method,
				document_kind: input.documentKind,
				matches_declared: outcome.matchesDeclared,
				regime: outcome.regime
			}
		});
		// A conflict is decided once; one reopened later is decided at another moment.
		await notify(tx, {
			userId: candidate.userId,
			type: 'candidate.age_verified',
			objectId: candidateId,
			stage: now.toISOString(),
			payload: { regime: outcome.regime, hidden: outcome.hidden }
		});
		return outcome;
	});
}
