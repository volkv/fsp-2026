// Reads shared by the invitation entry points: the acting side, the invitation under a row lock, its vacancy and the
// history of its terms.
import { asc, eq } from 'drizzle-orm';
import type { AccessSubject } from '$lib/server/access/permissions';
import { auditActor, type RequestMeta } from './deps';
import { recordAuditEvent, type AuditEventInput } from '$lib/server/audit/record';
import type { Database, Executor, Transaction } from '$lib/server/db';
import { invitations, invitationTerms, vacancies } from '$lib/server/db/schema';
import { refuse, Refusal } from './errors';
import type { OfferedSalary, TermsVersionFacts, VacancySnapshot } from './terms';

export type InvitationRow = typeof invitations.$inferSelect;
export type TermsRow = typeof invitationTerms.$inferSelect;
export type VacancyRow = typeof vacancies.$inferSelect;

export interface MemberSide {
	userId: string;
	memberId: string;
	companyId: string;
	companyStatus: 'draft' | 'submitted' | 'verified' | 'rejected' | 'suspended';
}

/** The subject acting for its company: signed in and an active member. */
export function memberSide(subject: AccessSubject): MemberSide {
	if (subject.userId === null) throw refuse('unauthenticated', 'unauthenticated');
	const membership = subject.membership;
	if (membership?.status !== 'active') throw refuse('forbidden', 'not_member');
	return {
		userId: subject.userId,
		memberId: membership.memberId,
		companyId: membership.companyId,
		companyStatus: membership.companyStatus
	};
}

/** The subject acting as a candidate. */
export function candidateSide(subject: AccessSubject): { userId: string; candidateId: string } {
	if (subject.userId === null) throw refuse('unauthenticated', 'unauthenticated');
	if (!subject.candidate) throw refuse('forbidden', 'not_candidate');
	return { userId: subject.userId, candidateId: subject.candidate.id };
}

/** The invitation locked for the transaction; a purged tombstone is not an invitation any more. */
export async function lockInvitation(tx: Transaction, invitationId: string): Promise<InvitationRow | null> {
	const [row] = await tx.select().from(invitations).where(eq(invitations.id, invitationId)).for('update');
	return row && row.purgedAt === null ? row : null;
}

export async function loadVacancy(executor: Executor, vacancyId: string): Promise<VacancyRow | null> {
	const [row] = await executor.select().from(vacancies).where(eq(vacancies.id, vacancyId));
	return row ?? null;
}

export async function loadTerms(executor: Executor, termsId: string): Promise<TermsRow> {
	const [row] = await executor.select().from(invitationTerms).where(eq(invitationTerms.id, termsId));
	if (!row) throw new Error(`terms ${termsId} do not exist`);
	return row;
}

export function termsSalary(row: TermsRow): OfferedSalary {
	const {
		salaryMin: min,
		salaryMax: max,
		salaryCurrency: currency,
		salaryPeriod: period,
		salaryTaxBase: taxBase
	} = row;
	if (
		min === null ||
		max === null ||
		currency === null ||
		period === null ||
		(taxBase !== 'gross' && taxBase !== 'net')
	) {
		throw new Error(`terms ${row.id} have no full salary`);
	}
	return { min, max, currency, period, taxBase };
}

export function termsFacts(row: TermsRow): TermsVersionFacts {
	return {
		version: row.version,
		snapshot: row.vacancySnapshot as VacancySnapshot,
		salary: termsSalary(row),
		message: row.message
	};
}

/** Every version of the invitation, oldest first. */
export async function termsHistory(executor: Executor, invitationId: string): Promise<TermsRow[]> {
	return executor
		.select()
		.from(invitationTerms)
		.where(eq(invitationTerms.invitationId, invitationId))
		.orderBy(asc(invitationTerms.version));
}

/**
 * Runs an action and journals its refusal: a refused action rolls its transaction back, so the denial is recorded
 * separately, with the internal reason that the response does not reveal (domain 7.4, 18).
 */
export async function journalRefusal<T>(
	db: Database,
	subject: AccessSubject,
	meta: RequestMeta,
	event: Pick<AuditEventInput, 'action' | 'object' | 'subjectCandidateId'> & { side: 'company' | 'candidate' },
	action: () => Promise<T>
): Promise<T> {
	try {
		return await action();
	} catch (error) {
		if (error instanceof Refusal && error.code !== 'validation_failed') {
			await recordAuditEvent(db, {
				action: event.action,
				outcome: 'denied',
				actor: auditActor(subject, meta, event.side),
				...(event.object ? { object: event.object } : {}),
				...(event.subjectCandidateId ? { subjectCandidateId: event.subjectCandidateId } : {}),
				requestId: meta.requestId,
				ip: meta.ip ?? null,
				userAgent: meta.userAgent ?? null,
				details: { reason: error.reason }
			});
		}
		throw error;
	}
}
