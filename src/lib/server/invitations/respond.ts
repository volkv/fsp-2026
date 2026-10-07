// The candidate's answer (docs/domain.md, sections 13.5, 13.6, 6.5): to a concrete version of the terms, accept with
// the disclosure consent of this invitation or decline with a reason. The first acceptance, the consent event that
// puts the disclosure in effect, the disclosure record and the hiring process are created in one transaction. A
// candidate aged 14–17 accepts with their own side of the consent; the answer then waits for the legal representative
// until the deadline of the version, and their consent completes it (`./disclosure`).
import { and, asc, desc, eq } from 'drizzle-orm';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import { recordAuditEvent } from '$lib/server/audit/record';
import { DISCLOSURE_FIELDS, REQUIRED_DISCLOSURE_FIELDS, type DisclosureField } from '$lib/server/consent/kinds';
import { representativeRefusal } from '$lib/server/consent/processing';
import type { Executor, Transaction } from '$lib/server/db';
import {
	candidates,
	companies,
	consentEvents,
	disclosures,
	hiringProcesses,
	invitationResponses,
	invitations,
	invitationTerms,
	representations,
	vacancies
} from '$lib/server/db/schema';
import { openHiringProcess } from '$lib/server/hiring/process';
import { demoSessionOfUser, inDemoScope } from '$lib/server/demo/scope';
import { emitCompanyEvent } from '$lib/server/events/emit';
import { cancelWaitingJobs } from '$lib/server/jobs/queue';
import { ageBand, isMinorBand } from '$lib/server/visibility/age';
import { currentDisclosureDocument, effectiveDisclosure, type EffectiveDisclosure } from './consent';
import { auditActor, channelOf, type InvitationDeps, type RequestMeta } from './deps';
import { invalid, refuse } from './errors';
import { notify } from '$lib/server/notifications/notify';
import { companyRecipients } from './notifications';
import { policyById } from './policies';
import { candidateSide, lockInvitation, loadTerms, type InvitationRow, type TermsRow } from './records';
import { cancelTermsJobs } from './schedule';
import type { TermsChanges } from './terms';

const REASON_TEXT_MAX = 2000;

/**
 * The second barrier of the demo sessions (domain 19.3) behind the lists: the candidate acts on an invitation of a
 * company in their own place only — of their demo session, or outside sessions and not an original of the cast. Any
 * other invitation is «not found», as one that does not exist.
 */
async function requireCompanyInReach(executor: Executor, userId: string, companyId: string): Promise<void> {
	const [company] = await executor
		.select({ demoSessionId: companies.demoSessionId, demoOriginal: companies.demoOriginal })
		.from(companies)
		.where(eq(companies.id, companyId));
	if (!company) throw new Error(`company ${companyId} does not exist`);
	if (!inDemoScope(company, await demoSessionOfUser(executor, userId))) {
		throw refuse('not_found', 'not_in_demo_scope');
	}
}

/** The candidate opened the invitation: `sent → viewed`. */
export async function markInvitationViewed(
	deps: InvitationDeps,
	subject: AccessSubject,
	invitationId: string
): Promise<InvitationRow['status']> {
	const side = candidateSide(subject);
	return deps.db.transaction(async (tx) => {
		const invitation = await lockInvitation(tx, invitationId);
		if (!invitation || invitation.candidateId !== side.candidateId) throw refuse('not_found', 'not_addressee');
		await requireCompanyInReach(tx, side.userId, invitation.companyId);
		if (invitation.status !== 'sent') return invitation.status;
		await tx
			.update(invitations)
			.set({ status: 'viewed', viewedAt: invitation.viewedAt ?? deps.now() })
			.where(eq(invitations.id, invitation.id));
		return 'viewed';
	});
}

export type ResponseInput =
	| {
			termsId: string;
			decision: 'accept';
			/** Fields the company receives; full name and email are the required minimum. */
			discloseFields: readonly string[];
			/** The version of the disclosure consent text shown to the candidate. */
			disclosureDocumentId: string;
	  }
	| { termsId: string; decision: 'decline'; reasonCode?: string; reasonText?: string };

export interface ResponseResult {
	status: InvitationRow['status'];
	/** The hiring process opened by the first acceptance, or the existing one. */
	processId: string | null;
	/** Fields the company may receive under the disclosure consent now in effect. */
	disclosedFields: DisclosureField[];
	/**
	 * The candidate aged 14–17 accepted with their own side of the disclosure consent; the acceptance waits for the
	 * legal representative, whom the caller sends the letter (`sendDisclosureLetter`).
	 */
	awaitingRepresentative: boolean;
}

/** Reason code of an answer the legal representative gave for the candidate: no consent to the disclosure. */
export const REPRESENTATIVE_DECLINED = 'representative_declined';

/** An acceptance of a candidate aged 14–17 that waits for the representative's consent to the disclosure. */
export interface PendingRepresentativeDisclosure {
	/** The version the candidate accepted: the current one, still answerable. */
	termsId: string;
	/** The candidate's own grant of the disclosure, made with this answer. */
	subjectGrantId: string;
	/** What the candidate chose to hand over: the representative consents to exactly these fields. */
	fields: DisclosureField[];
	requestedAt: Date;
	/** The deadline of the version: the representative answers within the window of the terms (domain 13.5). */
	dueAt: Date;
}

/**
 * The acceptance of the current version waiting for the representative, or `null`. It waits while the invitation is
 * open to an answer, the version has no answer and its deadline has not passed, the candidate is 14–17, the candidate's
 * last event of the disclosure consent of this invitation is a grant given for this version, and the consent is not in
 * effect yet. A revision, the deadline, the withdrawal, the candidate's revocation or the representative's answer end
 * the wait by themselves: nothing is stored besides the consent events.
 */
export async function pendingRepresentativeDisclosure(
	executor: Executor,
	invitation: InvitationRow,
	now: Date
): Promise<PendingRepresentativeDisclosure | null> {
	if (invitation.currentTermsId === null) return null;
	if (invitation.status !== 'sent' && invitation.status !== 'viewed' && invitation.status !== 'accepted') return null;
	const terms = await loadTerms(executor, invitation.currentTermsId);
	if (terms.responseDueAt <= now) return null;
	const [answered] = await executor
		.select({ id: invitationResponses.id })
		.from(invitationResponses)
		.where(eq(invitationResponses.termsId, terms.id));
	if (answered) return null;
	const [candidate] = await executor
		.select({
			birthDate: candidates.birthDate,
			precision: candidates.birthDatePrecision,
			status: candidates.birthDateStatus
		})
		.from(candidates)
		.where(eq(candidates.id, invitation.candidateId));
	if (!candidate || !isMinorBand(ageBand(candidate, now))) return null;
	const [last] = await executor
		.select({
			id: consentEvents.id,
			action: consentEvents.action,
			scopeFields: consentEvents.scopeFields,
			occurredAt: consentEvents.occurredAt
		})
		.from(consentEvents)
		.where(
			and(
				eq(consentEvents.subjectCandidateId, invitation.candidateId),
				eq(consentEvents.kind, 'contact_disclosure'),
				eq(consentEvents.scopeInvitationId, invitation.id),
				eq(consentEvents.signerKind, 'subject')
			)
		)
		.orderBy(desc(consentEvents.occurredAt), desc(consentEvents.id))
		.limit(1);
	if (last?.action !== 'grant' || last.occurredAt < terms.createdAt) return null;
	if (await effectiveDisclosure(executor, invitation.candidateId, { invitationId: invitation.id }, now)) return null;
	return {
		termsId: terms.id,
		subjectGrantId: last.id,
		fields: DISCLOSURE_FIELDS.filter((field) => (last.scopeFields ?? []).includes(field)),
		requestedAt: last.occurredAt,
		dueAt: terms.responseDueAt
	};
}

/** The representation of the candidate whose authority is verified now, or `null`. */
export async function verifiedRepresentationId(executor: Executor, candidateId: string): Promise<string | null> {
	const [row] = await executor
		.select({ id: representations.id })
		.from(representations)
		.where(and(eq(representations.candidateId, candidateId), eq(representations.status, 'authority_verified')))
		.orderBy(asc(representations.invitedAt))
		.limit(1);
	return row?.id ?? null;
}

function disclosureChoice(fields: readonly string[]): DisclosureField[] {
	const chosen = DISCLOSURE_FIELDS.filter((field) => fields.includes(field));
	if (chosen.length !== new Set(fields).size) throw invalid('disclose_fields', 'Неизвестное поле раскрытия');
	if (!REQUIRED_DISCLOSURE_FIELDS.every((field) => chosen.includes(field))) {
		throw invalid('disclose_fields', 'ФИО и почта раскрываются всегда');
	}
	return chosen;
}

function termsReplaced(changes: TermsChanges | null) {
	return refuse(
		'conflict',
		'terms_replaced',
		(changes?.fields ?? []).map((change) => ({ path: change.field, code: 'changed', message: 'Условие изменено' }))
	);
}

export async function respondToInvitation(
	deps: InvitationDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	invitationId: string,
	input: ResponseInput
): Promise<ResponseResult> {
	const side = candidateSide(subject);
	return deps.db.transaction(async (tx) => {
		const now = deps.now();
		// The vacancy of the version is locked before the offer, in the order closing the vacancy takes them.
		const vacancy = await lockVacancyOf(tx, invitationId);
		const invitation = await lockInvitation(tx, invitationId);
		if (!invitation || invitation.candidateId !== side.candidateId) throw refuse('not_found', 'not_addressee');
		await requireCompanyInReach(tx, side.userId, invitation.companyId);
		const access = can(subject, 'invitation.respond', { candidateId: invitation.candidateId });
		if (!access.allowed) throw refuse('forbidden', `access_${access.reason}`);
		if (invitation.currentTermsId === null) throw new Error(`invitation ${invitation.id} has no terms`);

		const current = await loadTerms(tx, invitation.currentTermsId);
		if (input.termsId !== current.id) {
			const [answered] = await tx
				.select({ invitationId: invitationTerms.invitationId })
				.from(invitationTerms)
				.where(eq(invitationTerms.id, input.termsId));
			if (answered?.invitationId !== invitation.id) throw refuse('not_found', 'unknown_terms');
			// A version replaced by a revision is not answerable: the candidate sees what changed.
			throw termsReplaced(current.changes as TermsChanges | null);
		}
		if (invitation.status === 'declined' || invitation.status === 'expired' || invitation.status === 'withdrawn') {
			throw refuse('conflict', 'invitation_closed');
		}
		// A closed vacancy hires no one: unanswered offers naming it are withdrawn when it closes, and a revision of an
		// accepted one naming it is not accepted either (domain 13.5).
		if (input.decision === 'accept' && vacancy?.status === 'closed') {
			throw refuse('conflict', 'vacancy_closed');
		}
		const [answered] = await tx
			.select({ id: invitationResponses.id })
			.from(invitationResponses)
			.where(eq(invitationResponses.termsId, current.id));
		if (answered) throw refuse('conflict', 'already_answered');
		if (current.responseDueAt <= now) throw refuse('conflict', 'response_overdue');

		const journal = {
			actor: auditActor(subject, meta, 'candidate'),
			object: { type: 'invitation', id: invitation.id },
			subjectCandidateId: invitation.candidateId,
			requestId: meta.requestId,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null,
			occurredAt: now
		};
		if (input.decision === 'decline') {
			const result = await decline(tx, invitation, current.id, input, now);
			await closeAnswer(tx, invitation, current, journal, {
				decision: 'decline',
				reasonCode: input.reasonCode ?? null,
				byRepresentative: false
			});
			return result;
		}
		return accept(tx, subject, meta, invitation, current, input, now, journal);
	});
}

type Journal = Omit<Parameters<typeof recordAuditEvent>[1], 'action' | 'outcome' | 'details'>;

/**
 * What every answer ends with: the jobs of the answered version are cancelled, the company is told and the answer is
 * journaled. `byRepresentative` — the legal representative's answer completed or refused the candidate's acceptance.
 */
export async function closeAnswer(
	tx: Transaction,
	invitation: InvitationRow,
	terms: TermsRow,
	journal: Journal,
	answer: { decision: 'accept' | 'decline'; reasonCode: string | null; byRepresentative: boolean }
): Promise<void> {
	await cancelTermsJobs(tx, terms.id);
	for (const userId of await companyRecipients(tx, invitation)) {
		await notify(tx, {
			userId,
			type: 'invitation.answered',
			objectId: invitation.id,
			stage: `v${terms.version}:${userId}`,
			payload: {
				invitation_id: invitation.id,
				terms_id: terms.id,
				decision: answer.decision,
				by_representative: answer.byRepresentative
			}
		});
	}
	await emitCompanyEvent(tx, {
		companyId: invitation.companyId,
		type: answer.decision === 'accept' ? 'invitation.accepted' : 'invitation.declined',
		invitationId: invitation.id,
		data: {
			invitation_id: invitation.id,
			terms_id: terms.id,
			terms_version: terms.version,
			reason_code: answer.reasonCode,
			by_representative: answer.byRepresentative
		},
		occurredAt: journal.occurredAt ?? new Date()
	});
	await recordAuditEvent(tx, {
		...journal,
		action: 'invitation.responded',
		outcome: 'success',
		details: {
			decision: answer.decision,
			terms_id: terms.id,
			reason_code: answer.reasonCode,
			by_representative: answer.byRepresentative
		}
	});
}

async function decline(
	tx: Transaction,
	invitation: InvitationRow,
	termsId: string,
	input: Extract<ResponseInput, { decision: 'decline' }>,
	now: Date
): Promise<ResponseResult> {
	const policy = await policyById(tx, 'invitation_policy', invitation.policyId);
	if (input.reasonCode === undefined) {
		if (policy.params.reason_required) throw invalid('reason_code', 'Укажите причину отказа');
	} else if (!policy.params.decline_reason_codes.includes(input.reasonCode)) {
		throw invalid('reason_code', 'Причина не из справочника');
	}
	const reasonText = input.reasonText?.trim() ? input.reasonText.trim() : null;
	if (reasonText !== null && reasonText.length > REASON_TEXT_MAX) {
		throw invalid('reason_text', `Комментарий длиннее ${REASON_TEXT_MAX} символов`);
	}
	return recordDecline(tx, invitation, termsId, { reasonCode: input.reasonCode ?? null, reasonText }, now);
}

/** The refusal of a version: the answer row and, unless a previous version stays accepted, the closed invitation. */
export async function recordDecline(
	tx: Transaction,
	invitation: InvitationRow,
	termsId: string,
	reason: { reasonCode: string | null; reasonText: string | null },
	now: Date
): Promise<ResponseResult> {
	await tx.insert(invitationResponses).values({
		invitationId: invitation.id,
		termsId,
		decision: 'decline',
		reasonCode: reason.reasonCode,
		reasonText: reason.reasonText,
		respondedAt: now
	});
	// Declining a revision of an accepted invitation keeps the accepted version (domain 13.5).
	const status = invitation.status === 'accepted' ? 'accepted' : 'declined';
	if (status === 'declined') {
		await tx.update(invitations).set({ status, closedAt: now }).where(eq(invitations.id, invitation.id));
	}
	const disclosure = await effectiveDisclosure(tx, invitation.candidateId, { invitationId: invitation.id }, now);
	return {
		status,
		processId: await processIdOf(tx, invitation.id),
		disclosedFields: disclosure?.fields ?? [],
		awaitingRepresentative: false
	};
}

/**
 * The vacancy the current version of the offer names, under a share lock: closing it waits for the answer, or the
 * answer sees it closed. `null` — the version names no vacancy, or there is no such offer.
 */
export async function lockVacancyOf(tx: Transaction, invitationId: string): Promise<{ status: string } | null> {
	const [row] = await tx
		.select({ status: vacancies.status })
		.from(invitations)
		.innerJoin(invitationTerms, eq(invitationTerms.id, invitations.currentTermsId))
		.innerJoin(vacancies, eq(vacancies.id, invitationTerms.vacancyId))
		.where(eq(invitations.id, invitationId))
		.for('share', { of: vacancies });
	return row ?? null;
}

async function processIdOf(tx: Transaction, invitationId: string): Promise<string | null> {
	const [row] = await tx
		.select({ id: hiringProcesses.id })
		.from(hiringProcesses)
		.where(eq(hiringProcesses.invitationId, invitationId));
	return row?.id ?? null;
}

async function accept(
	tx: Transaction,
	subject: AccessSubject,
	meta: RequestMeta,
	invitation: InvitationRow,
	terms: TermsRow,
	input: Extract<ResponseInput, { decision: 'accept' }>,
	now: Date,
	journal: Journal
): Promise<ResponseResult> {
	const chosen = disclosureChoice(input.discloseFields);
	const candidateUserId = subject.userId;
	if (candidateUserId === null) throw new Error('an answer is given by a signed-in candidate');
	const before = await effectiveDisclosure(tx, invitation.candidateId, { invitationId: invitation.id }, now);
	if (!before && (await pendingRepresentativeDisclosure(tx, invitation, now))) {
		throw refuse('conflict', 'awaiting_representative', [
			{
				code: 'awaiting_representative',
				message:
					'Вы уже приняли это приглашение: ждём согласия законного представителя. Письмо можно отправить ему ещё раз.'
			}
		]);
	}

	// A new grant only when there is none in effect or the candidate adds fields; the grant keeps what was granted.
	let grantId: string | null = null;
	if (!before || chosen.some((field) => !before.fields.includes(field))) {
		const document = await currentDisclosureDocument(tx, now);
		if (!document) throw new Error('no contact_disclosure document is published');
		if (input.disclosureDocumentId !== document.id) throw refuse('conflict', 'disclosure_document_changed');
		const fields = DISCLOSURE_FIELDS.filter((field) => chosen.includes(field) || before?.fields.includes(field));
		const [grant] = await tx
			.insert(consentEvents)
			.values({
				subjectCandidateId: invitation.candidateId,
				kind: 'contact_disclosure',
				documentId: document.id,
				action: 'grant',
				signerKind: 'subject',
				signerUserId: candidateUserId,
				scopeCompanyId: invitation.companyId,
				scopeInvitationId: invitation.id,
				scopeFields: fields,
				method: 'separate_screen_button',
				evidence: {
					ip: meta.ip ?? null,
					user_agent: meta.userAgent ?? null,
					session_hash: meta.sessionHash ?? null,
					document_sha256: document.bodySha256
				},
				occurredAt: now
			})
			.returning({ id: consentEvents.id });
		if (!grant) throw new Error('consent event not inserted');
		grantId = grant.id;
		await recordAuditEvent(tx, {
			...journal,
			action: 'consent.granted',
			outcome: 'success',
			details: { kind: 'contact_disclosure', consent_event_id: grant.id, fields }
		});
	}

	// Without the disclosure consent in effect there is no acceptance. For ages 14–17 the verified representative
	// grants it for this invitation as well (domain 6.3): the candidate's side is kept and the answer waits for them.
	const effective = await effectiveDisclosure(tx, invitation.candidateId, { invitationId: invitation.id }, now);
	if (!effective) {
		const [candidate] = await tx
			.select({
				birthDate: candidates.birthDate,
				precision: candidates.birthDatePrecision,
				status: candidates.birthDateStatus
			})
			.from(candidates)
			.where(eq(candidates.id, invitation.candidateId));
		if (!candidate || !isMinorBand(ageBand(candidate, now))) throw refuse('forbidden', 'no_disclosure_consent');
		if ((await verifiedRepresentationId(tx, invitation.candidateId)) === null) {
			const refusal = await representativeRefusal(tx, invitation.candidateId, 'disclosure');
			throw refuse('policy_violation', 'representative_consent_required', [refusal]);
		}
		// The candidate answered: the reminders of the deadline are not needed. The deadline itself stays — the
		// representative answers within the window of the version, or the invitation expires.
		await cancelWaitingJobs(tx, 'invitation.remind_due', { terms_id: terms.id });
		return {
			status: invitation.status,
			processId: await processIdOf(tx, invitation.id),
			disclosedFields: [],
			awaitingRepresentative: true
		};
	}
	return finishAcceptance(tx, {
		invitation,
		terms,
		effective,
		grantId,
		channel: channelOf(subject),
		candidateUserId,
		journal,
		byRepresentative: false,
		now
	});
}

/**
 * The acceptance with the disclosure consent in effect: the newly disclosed fields are recorded, the answer is stored,
 * the invitation is accepted and the first acceptance opens the hiring process; the company is told.
 */
export async function finishAcceptance(
	tx: Transaction,
	input: {
		invitation: InvitationRow;
		terms: TermsRow;
		effective: EffectiveDisclosure;
		/** The candidate's grant made with this answer, if any. */
		grantId: string | null;
		channel: 'ui' | 'api';
		candidateUserId: string;
		journal: Journal;
		byRepresentative: boolean;
		now: Date;
	}
): Promise<ResponseResult> {
	const { invitation, terms, effective, journal, now } = input;
	const alreadyDisclosed = new Set(
		(
			await tx
				.select({ fields: disclosures.fields })
				.from(disclosures)
				.where(and(eq(disclosures.invitationId, invitation.id), eq(disclosures.companyId, invitation.companyId)))
		).flatMap((row) => row.fields)
	);
	const newlyDisclosed = effective.fields.filter((field) => !alreadyDisclosed.has(field));
	if (newlyDisclosed.length > 0) {
		await tx.insert(disclosures).values({
			candidateId: invitation.candidateId,
			companyId: invitation.companyId,
			recipientMemberId: invitation.sentByMemberId,
			invitationId: invitation.id,
			consentEventId: effective.consentEventId,
			fields: newlyDisclosed,
			channel: input.channel,
			disclosedAt: now
		});
		await emitCompanyEvent(tx, {
			companyId: invitation.companyId,
			type: 'contacts.disclosed',
			invitationId: invitation.id,
			data: { invitation_id: invitation.id, fields: newlyDisclosed },
			occurredAt: now
		});
		await recordAuditEvent(tx, {
			...journal,
			action: 'contacts.disclosed',
			outcome: 'success',
			details: { invitation_id: invitation.id, company_id: invitation.companyId, fields: newlyDisclosed }
		});
	}

	await tx.insert(invitationResponses).values({
		invitationId: invitation.id,
		termsId: terms.id,
		decision: 'accept',
		consentEventId: input.grantId,
		respondedAt: now
	});
	const firstAcceptance = invitation.acceptedTermsId === null;
	await tx
		.update(invitations)
		.set({ status: 'accepted', acceptedTermsId: terms.id })
		.where(eq(invitations.id, invitation.id));
	const processId = firstAcceptance
		? await openHiringProcess(tx, invitation, now, { kind: 'user', id: input.candidateUserId })
		: await processIdOf(tx, invitation.id);
	await closeAnswer(tx, invitation, terms, journal, {
		decision: 'accept',
		reasonCode: null,
		byRepresentative: input.byRepresentative
	});
	return { status: 'accepted', processId, disclosedFields: effective.fields, awaitingRepresentative: false };
}
