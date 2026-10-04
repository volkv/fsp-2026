// Sending terms (docs/domain.md, sections 13.5, 4.2): the first version of an invitation, a revision and a reopening
// are the same act — a new immutable version that requires `isInvitable(vacancy)` and `canShow` in the context of the
// vacancy at the moment of sending. Withdrawal by the company and by the system closes an unanswered invitation.
import { and, count, eq, gt, inArray, sql } from 'drizzle-orm';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import { recordAuditEvent } from '$lib/server/audit/record';
import { loadCompanyGate } from '$lib/server/companies/gate';
import type { Transaction } from '$lib/server/db';
import { candidates, invitations, invitationTerms } from '$lib/server/db/schema';
import { uuidv7 } from '$lib/server/ids';
import { vacancySnapshot } from '$lib/server/matching/evidence';
import { storeInvitedPair } from '$lib/server/matching/storage';
import { isInvitable, type Invitability } from '$lib/server/vacancies/invitable';
import { auditActor, type InvitationDeps, type RequestMeta } from './deps';
import { invalid, refuse, violation } from './errors';
import { notify } from '$lib/server/notifications/notify';
import { policyById, requiredPolicy } from './policies';
import {
	journalRefusal,
	lockInvitation,
	loadVacancy,
	memberSide,
	termsFacts,
	termsHistory,
	type InvitationRow,
	type MemberSide,
	type VacancyRow
} from './records';
import { cancelTermsJobs, scheduleTermsJobs } from './schedule';
import { offeredSalary, termsChanges, vacancySnapshotOf, type OfferedSalary, type TermsChanges } from './terms';
import { showInVacancyContext } from './visibility';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MESSAGE_MAX = 4000;

export interface TermsInput {
	salaryMin: number;
	salaryMax: number;
	message?: string | null;
}

function validTerms(input: TermsInput): { salaryMin: number; salaryMax: number; message: string | null } {
	if (!Number.isSafeInteger(input.salaryMin) || input.salaryMin <= 0) {
		throw invalid('salary_min', 'Нижняя граница — целое положительное число');
	}
	if (!Number.isSafeInteger(input.salaryMax) || input.salaryMax < input.salaryMin) {
		throw invalid('salary_max', 'Верхняя граница — целое число не меньше нижней');
	}
	const message = input.message?.trim() ? input.message.trim() : null;
	if (message !== null && message.length > MESSAGE_MAX) {
		throw invalid('message', `Сообщение длиннее ${MESSAGE_MAX} символов`);
	}
	return { salaryMin: input.salaryMin, salaryMax: input.salaryMax, message };
}

const OPEN_STATUSES = ['sent', 'viewed'] as const;
const CLOSED_STATUSES = ['declined', 'expired', 'withdrawn'] as const;

/**
 * The checks of every sent version, in the order that gives each refusal its own code: another company's vacancy is
 * unknown to the member (`404`), an external vacancy is a policy violation (`422 vacancy_not_invitable`), a member of
 * an unverified company may not invite (`403`), a vacancy that is not invitable is `422`, a candidate the company does
 * not see in the context of the vacancy is `404` whatever the reason (revoked catalog consent, a minor without a
 * verified representative, a vacancy not open to the candidate's age).
 */
async function authorizeSending(
	tx: Transaction,
	subject: AccessSubject,
	member: MemberSide,
	vacancy: VacancyRow | null,
	candidateId: string,
	now: Date
): Promise<{ vacancy: VacancyRow; salaryUnitOf: (min: number, max: number) => OfferedSalary }> {
	if (!vacancy || (vacancy.origin === 'own' && vacancy.companyId !== member.companyId)) {
		throw refuse('not_found', 'foreign_vacancy');
	}
	if (vacancy.origin === 'external') throw violation('vacancy_not_invitable', 'vacancy_id');
	// Read in this transaction with the row locked: a suspension running at the same time is ordered with the sending.
	const company = await loadCompanyGate(tx, member.companyId, { forUpdate: true });
	if (!company.allowed) throw refuse('forbidden', 'company_not_verified');

	const invitability: Invitability = isInvitable({ ...vacancy, company });
	if (!invitability.invitable) throw violation('vacancy_not_invitable', 'vacancy_id');

	const { decision } = await showInVacancyContext(tx, subject, candidateId, vacancy, now);
	if (!decision.allowed) throw refuse('not_found', decision.reason);

	const access = can(subject, 'invitation.create', { invitability, show: decision });
	if (!access.allowed) throw refuse('forbidden', `access_${access.reason}`);

	return {
		vacancy,
		salaryUnitOf: (min, max) => {
			const salary = offeredSalary(vacancy, min, max);
			if (!salary) throw new Error(`invitable vacancy ${vacancy.id} has no full salary unit`);
			// The lower bound of a version is not below the range of the vacancy at that moment (domain 13.5).
			if (vacancy.salaryMin !== null && min < vacancy.salaryMin) throw violation('salary_below_vacancy', 'salary_min');
			return salary;
		}
	};
}

async function candidateUserId(tx: Transaction, candidateId: string): Promise<string> {
	const [row] = await tx.select({ userId: candidates.userId }).from(candidates).where(eq(candidates.id, candidateId));
	if (!row) throw new Error(`candidate ${candidateId} does not exist`);
	return row.userId;
}

export interface CreateInvitationInput extends TermsInput {
	vacancyId: string;
	candidateId: string;
}

export interface SentTerms {
	invitationId: string;
	termsId: string;
	version: number;
	responseDueAt: Date;
}

/** Sends the first version of the only invitation of this company, vacancy and candidate. */
export async function createInvitation(
	deps: InvitationDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	input: CreateInvitationInput
): Promise<SentTerms> {
	const terms = validTerms(input);
	return journalRefusal(
		deps.db,
		subject,
		meta,
		{ action: 'invitation.sent', subjectCandidateId: input.candidateId, side: 'company' },
		() =>
			deps.db.transaction(async (tx) => {
				const now = deps.now();
				const member = memberSide(subject);
				const { vacancy, salaryUnitOf } = await authorizeSending(
					tx,
					subject,
					member,
					await loadVacancy(tx, input.vacancyId),
					input.candidateId,
					now
				);
				const salary = salaryUnitOf(terms.salaryMin, terms.salaryMax);
				const policy = await requiredPolicy(tx, 'invitation_policy', now);

				const [sentToday] = await tx
					.select({ value: count() })
					.from(invitations)
					.where(
						and(eq(invitations.companyId, member.companyId), gt(invitations.sentAt, new Date(now.getTime() - DAY)))
					);
				if ((sentToday?.value ?? 0) >= policy.params.max_open_per_company_per_day) {
					throw refuse('rate_limited', 'daily_invitation_limit');
				}

				const invitationId = uuidv7();
				const termsId = uuidv7();
				const responseDueAt = new Date(now.getTime() + policy.params.response_window_hours * HOUR);
				const inserted = await tx
					.insert(invitations)
					.values({
						id: invitationId,
						companyId: member.companyId,
						vacancyId: vacancy.id,
						candidateId: input.candidateId,
						sentByMemberId: member.memberId,
						status: 'sent',
						currentTermsId: termsId,
						// «Why invited»: the match of the pair at the moment of the first sending, stored whatever its score.
						matchScoreId: await storeInvitedPair(tx, vacancySnapshot(vacancy), input.candidateId),
						policyId: policy.id,
						sentAt: now
					})
					.onConflictDoNothing({ target: [invitations.companyId, invitations.vacancyId, invitations.candidateId] })
					.returning({ id: invitations.id });
				// One invitation per company, vacancy and candidate for all time: a new offer is a version of it.
				if (inserted.length === 0) throw refuse('conflict', 'invitation_exists');
				await tx.insert(invitationTerms).values({
					id: termsId,
					invitationId,
					version: 1,
					vacancySnapshot: vacancySnapshotOf(vacancy),
					salaryMin: salary.min,
					salaryMax: salary.max,
					salaryCurrency: salary.currency,
					salaryPeriod: salary.period,
					salaryTaxBase: salary.taxBase,
					message: terms.message,
					responseDueAt,
					createdByMemberId: member.memberId,
					createdAt: now
				});

				await scheduleTermsJobs(tx, { id: termsId, responseDueAt }, now, { kind: 'user', id: member.userId });
				await notify(tx, {
					userId: await candidateUserId(tx, input.candidateId),
					type: 'invitation.received',
					objectId: invitationId,
					payload: { invitation_id: invitationId, terms_id: termsId }
				});
				await recordAuditEvent(tx, {
					action: 'invitation.sent',
					outcome: 'success',
					actor: auditActor(subject, meta, 'company'),
					object: { type: 'invitation', id: invitationId },
					subjectCandidateId: input.candidateId,
					requestId: meta.requestId,
					ip: meta.ip ?? null,
					userAgent: meta.userAgent ?? null,
					details: { vacancy_id: vacancy.id, terms_id: termsId, version: 1 },
					occurredAt: now
				});
				return { invitationId, termsId, version: 1, responseDueAt };
			})
	);
}

export interface RevisedTerms extends SentTerms {
	changes: TermsChanges;
	reopened: boolean;
}

/**
 * A new version of the terms: a revision of an open or accepted invitation, or a reopening of a declined, expired or
 * withdrawn one after the cooldown of its policy. Sent versions never change; the previous version stops being
 * answerable, and an accepted invitation keeps its accepted version until the candidate answers the new one.
 */
export async function reviseInvitation(
	deps: InvitationDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	invitationId: string,
	input: TermsInput
): Promise<RevisedTerms> {
	const terms = validTerms(input);
	return journalRefusal(
		deps.db,
		subject,
		meta,
		{ action: 'invitation.sent', object: { type: 'invitation', id: invitationId }, side: 'company' },
		() =>
			deps.db.transaction(async (tx) => {
				const now = deps.now();
				const member = memberSide(subject);
				const invitation = await lockInvitation(tx, invitationId);
				if (!invitation || invitation.companyId !== member.companyId) throw refuse('not_found', 'foreign_invitation');
				const { vacancy, salaryUnitOf } = await authorizeSending(
					tx,
					subject,
					member,
					await loadVacancy(tx, invitation.vacancyId),
					invitation.candidateId,
					now
				);
				const policy = await policyById(tx, 'invitation_policy', invitation.policyId);
				const reopened = (CLOSED_STATUSES as readonly string[]).includes(invitation.status);
				if (reopened) {
					if (invitation.reopenCount >= policy.params.max_reopens) throw refuse('conflict', 'reopen_limit');
					const closedAt = invitation.closedAt ?? invitation.sentAt;
					if (now.getTime() < closedAt.getTime() + policy.params.reopen_cooldown_days * DAY) {
						throw violation('reopen_cooldown');
					}
				}
				const access = can(subject, 'invitation.revise', { companyId: invitation.companyId, revisable: true });
				if (!access.allowed) throw refuse('forbidden', `access_${access.reason}`);

				const salary = salaryUnitOf(terms.salaryMin, terms.salaryMax);
				const history = await termsHistory(tx, invitation.id);
				const snapshot = vacancySnapshotOf(vacancy);
				const changes = termsChanges({ snapshot, salary, message: terms.message }, history.map(termsFacts));
				const version = changes.previous_version + 1;
				const termsId = uuidv7();
				const responseDueAt = new Date(now.getTime() + policy.params.response_window_hours * HOUR);
				await tx.insert(invitationTerms).values({
					id: termsId,
					invitationId: invitation.id,
					version,
					vacancySnapshot: snapshot,
					salaryMin: salary.min,
					salaryMax: salary.max,
					salaryCurrency: salary.currency,
					salaryPeriod: salary.period,
					salaryTaxBase: salary.taxBase,
					message: terms.message,
					responseDueAt,
					changes,
					createdByMemberId: member.memberId,
					createdAt: now
				});
				await tx
					.update(invitations)
					.set({
						currentTermsId: termsId,
						// An accepted invitation stays accepted with its accepted version until the new one is answered.
						status: invitation.status === 'accepted' ? 'accepted' : 'sent',
						...(reopened ? { closedAt: null, reopenCount: invitation.reopenCount + 1 } : {})
					})
					.where(eq(invitations.id, invitation.id));

				if (invitation.currentTermsId !== null) await cancelTermsJobs(tx, invitation.currentTermsId);
				await scheduleTermsJobs(tx, { id: termsId, responseDueAt }, now, { kind: 'user', id: member.userId });
				await notify(tx, {
					userId: await candidateUserId(tx, invitation.candidateId),
					type: 'invitation.terms_revised',
					objectId: invitation.id,
					stage: `v${version}`,
					payload: {
						invitation_id: invitation.id,
						terms_id: termsId,
						version,
						salary_lowered: changes.salary_lowered,
						reopened
					}
				});
				const journal = {
					actor: auditActor(subject, meta, 'company'),
					object: { type: 'invitation', id: invitation.id },
					subjectCandidateId: invitation.candidateId,
					requestId: meta.requestId,
					ip: meta.ip ?? null,
					userAgent: meta.userAgent ?? null,
					occurredAt: now
				};
				await recordAuditEvent(tx, {
					...journal,
					action: 'invitation.terms_revised',
					outcome: 'success',
					details: { salary_lowered: changes.salary_lowered, terms_id: termsId, version }
				});
				if (reopened) {
					await recordAuditEvent(tx, {
						...journal,
						action: 'invitation.reopened',
						outcome: 'success',
						details: { reopen_count: invitation.reopenCount + 1, terms_id: termsId }
					});
				}
				return { invitationId: invitation.id, termsId, version, responseDueAt, changes, reopened };
			})
	);
}

/** Closes an unanswered invitation and tells the candidate; the reason is journaled. */
async function closeAsWithdrawn(
	tx: Transaction,
	invitation: InvitationRow,
	now: Date,
	journal: { actor: Parameters<typeof recordAuditEvent>[1]['actor']; requestId: string; cause: string }
): Promise<void> {
	await tx.update(invitations).set({ status: 'withdrawn', closedAt: now }).where(eq(invitations.id, invitation.id));
	if (invitation.currentTermsId !== null) await cancelTermsJobs(tx, invitation.currentTermsId);
	await notify(tx, {
		userId: await candidateUserId(tx, invitation.candidateId),
		type: 'invitation.withdrawn',
		objectId: invitation.id,
		payload: { invitation_id: invitation.id, cause: journal.cause }
	});
	await recordAuditEvent(tx, {
		action: 'invitation.withdrawn',
		outcome: 'success',
		actor: journal.actor,
		object: { type: 'invitation', id: invitation.id },
		subjectCandidateId: invitation.candidateId,
		requestId: journal.requestId,
		details: { cause: journal.cause },
		occurredAt: now
	});
}

/** The company withdraws an invitation the candidate has not answered. */
export async function withdrawInvitation(
	deps: InvitationDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	invitationId: string
): Promise<void> {
	await deps.db.transaction(async (tx) => {
		const now = deps.now();
		const member = memberSide(subject);
		const invitation = await lockInvitation(tx, invitationId);
		if (!invitation || invitation.companyId !== member.companyId) throw refuse('not_found', 'foreign_invitation');
		const access = can(subject, 'invitation.revise', { companyId: invitation.companyId, revisable: true });
		if (!access.allowed) throw refuse('forbidden', `access_${access.reason}`);
		if (!(OPEN_STATUSES as readonly string[]).includes(invitation.status)) throw refuse('conflict', 'not_open');
		await closeAsWithdrawn(tx, invitation, now, {
			actor: auditActor(subject, meta, 'company'),
			requestId: meta.requestId,
			cause: 'company'
		});
	});
}

export type WithdrawalCause = 'company_suspended' | 'company_rejected' | 'vacancy_closed' | 'account_deleted';

/**
 * Withdraws every unanswered invitation of a company, a vacancy or a candidate in the caller's transaction: the company
 * lost its verification, the vacancy was closed, the account is being deleted (domain 13.5, 19.1). Accepted
 * invitations stay: their hiring processes live on. Returns how many were withdrawn.
 */
export async function withdrawOpenInvitations(
	tx: Transaction,
	scope: { companyId: string } | { vacancyId: string } | { candidateId: string },
	cause: WithdrawalCause,
	journal: { requestId: string; at: Date }
): Promise<number> {
	const where =
		'companyId' in scope
			? eq(invitations.companyId, scope.companyId)
			: 'vacancyId' in scope
				? eq(invitations.vacancyId, scope.vacancyId)
				: eq(invitations.candidateId, scope.candidateId);
	const open = await tx
		.select()
		.from(invitations)
		.where(and(where, inArray(invitations.status, [...OPEN_STATUSES]), sql`${invitations.purgedAt} is null`))
		.for('update');
	for (const invitation of open) {
		if (cause === 'account_deleted') {
			await tx
				.update(invitations)
				.set({ status: 'withdrawn', closedAt: journal.at })
				.where(eq(invitations.id, invitation.id));
			if (invitation.currentTermsId !== null) await cancelTermsJobs(tx, invitation.currentTermsId);
			await recordAuditEvent(tx, {
				action: 'invitation.withdrawn',
				outcome: 'success',
				actor: { kind: 'system' },
				object: { type: 'invitation', id: invitation.id },
				subjectCandidateId: invitation.candidateId,
				requestId: journal.requestId,
				details: { cause },
				occurredAt: journal.at
			});
			continue;
		}
		await closeAsWithdrawn(tx, invitation, journal.at, {
			actor: { kind: 'system' },
			requestId: journal.requestId,
			cause
		});
	}
	return open.length;
}
