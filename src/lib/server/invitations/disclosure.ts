// Disclosed contacts (docs/domain.md, sections 6.5, 7.4, 14, 19.1): the recipient projection of an invitation is given
// only to the company of that invitation, only after acceptance and only while its disclosure consent is in effect.
// A revocation closes further access through the platform; what was handed over stays with the company. For a
// candidate aged 14–17 the legal representative answers by a one-time link of a letter: the consent completes the
// waiting acceptance, a refusal declines the version.
import { and, desc, eq } from 'drizzle-orm';
import type { AccessSubject } from '$lib/server/access/permissions';
import { recordAuditEvent, type AuditActor } from '$lib/server/audit/record';
import {
	consumeEmailToken,
	issueEmailToken,
	lastEmailTokenIssuedAt,
	usableEmailToken
} from '$lib/server/auth/email-tokens';
import type { DisclosureField } from '$lib/server/consent/kinds';
import {
	deliverRepresentativeLetter,
	LETTER_RESEND_INTERVAL_MS,
	verifiedRepresentation,
	type LetterResult,
	type RepresentativeDeps
} from '$lib/server/consent/representative';
import type { Executor, Transaction } from '$lib/server/db';
import {
	candidates,
	companies,
	consentEvents,
	invitations,
	invitationTerms,
	legalDocuments,
	resumeDocuments,
	users
} from '$lib/server/db/schema';
import { notify } from '$lib/server/notifications/notify';
import { representativeDisclosureLetter, representativeDisclosureLink } from '$lib/server/notifications/representative';
import { currentDisclosureDocument, effectiveDisclosure } from './consent';
import { auditActor, type InvitationDeps, type RequestMeta } from './deps';
import { refuse } from './errors';
import {
	candidateSide,
	journalRefusal,
	lockInvitation,
	memberSide,
	termsSalary,
	type InvitationRow,
	type TermsRow
} from './records';
import {
	closeAnswer,
	finishAcceptance,
	lockVacancyOf,
	pendingRepresentativeDisclosure,
	recordDecline,
	REPRESENTATIVE_DECLINED,
	verifiedRepresentationId,
	type PendingRepresentativeDisclosure,
	type ResponseResult
} from './respond';
import type { OfferedSalary } from './terms';
import { showInInvitationContext } from './visibility';

export interface RecipientContacts {
	candidateId: string;
	pseudonym: string;
	fields: DisclosureField[];
	fullName?: { last: string | null; first: string | null; middle: string | null };
	email?: string;
	phone?: string | null;
	telegram?: string | null;
	resumeFileId?: string | null;
}

/** Contacts of the candidate of an invitation for a member of its company; `404` for anyone else. */
export async function recipientContacts(
	deps: InvitationDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	invitationId: string
): Promise<RecipientContacts> {
	return journalRefusal(
		deps.db,
		subject,
		meta,
		{ action: 'card.viewed_recipient', object: { type: 'invitation', id: invitationId }, side: 'company' },
		() =>
			deps.db.transaction(async (tx) => {
				const now = deps.now();
				const member = memberSide(subject);
				const invitation = await lockInvitation(tx, invitationId);
				if (!invitation || invitation.companyId !== member.companyId) throw refuse('not_found', 'foreign_invitation');
				const { decision, disclosure } = await showInInvitationContext(tx, subject, invitation, now);
				if (!decision.allowed) throw refuse('not_found', decision.reason);
				if (decision.projection !== 'recipient' || !disclosure) throw refuse('not_found', 'no_disclosure_consent');

				const [candidate] = await tx
					.select({
						lastNameEnc: candidates.lastNameEnc,
						firstNameEnc: candidates.firstNameEnc,
						middleNameEnc: candidates.middleNameEnc,
						phoneEnc: candidates.phoneEnc,
						telegramEnc: candidates.telegramEnc,
						emailEnc: users.emailEnc
					})
					.from(candidates)
					.innerJoin(users, eq(users.id, candidates.userId))
					.where(eq(candidates.id, invitation.candidateId));
				if (!candidate) throw new Error(`candidate ${invitation.candidateId} does not exist`);
				const open = (value: Uint8Array | null, context: Parameters<typeof deps.crypto.decrypt>[1]) =>
					value === null ? null : deps.crypto.decrypt(value, context);
				const fields = new Set(disclosure.fields);
				const contacts: RecipientContacts = {
					candidateId: invitation.candidateId,
					pseudonym: deps.crypto.pseudonym(invitation.candidateId, invitation.companyId),
					fields: disclosure.fields
				};
				if (fields.has('full_name')) {
					contacts.fullName = {
						last: open(candidate.lastNameEnc, 'candidates.last_name'),
						first: open(candidate.firstNameEnc, 'candidates.first_name'),
						middle: open(candidate.middleNameEnc, 'candidates.middle_name')
					};
				}
				if (fields.has('email')) {
					const email = open(candidate.emailEnc, 'users.email');
					if (email === null) throw new Error(`user of candidate ${invitation.candidateId} has no email`);
					contacts.email = email;
				}
				if (fields.has('phone')) contacts.phone = open(candidate.phoneEnc, 'candidates.phone');
				if (fields.has('telegram')) contacts.telegram = open(candidate.telegramEnc, 'candidates.telegram');
				if (fields.has('resume')) {
					const [resume] = await tx
						.select({ fileId: resumeDocuments.fileId })
						.from(resumeDocuments)
						.where(and(eq(resumeDocuments.candidateId, invitation.candidateId), eq(resumeDocuments.isCurrent, true)));
					contacts.resumeFileId = resume?.fileId ?? null;
				}
				await recordAuditEvent(tx, {
					action: 'card.viewed_recipient',
					outcome: 'success',
					actor: auditActor(subject, meta, 'company'),
					object: { type: 'invitation', id: invitation.id },
					subjectCandidateId: invitation.candidateId,
					requestId: meta.requestId,
					ip: meta.ip ?? null,
					userAgent: meta.userAgent ?? null,
					details: { fields: disclosure.fields, consent_event_id: disclosure.consentEventId },
					occurredAt: now
				});
				return contacts;
			})
	);
}

/**
 * The candidate revokes the disclosure consent of an invitation: the company loses the recipient projection at once;
 * the disclosure records stay as proof of what was lawfully handed over. A candidate aged 14–17 revokes their own side
 * as well while it waits for the representative: the acceptance is withdrawn and the representative's link stops
 * working.
 */
export async function revokeDisclosureConsent(
	deps: InvitationDeps,
	subject: AccessSubject,
	meta: RequestMeta,
	invitationId: string,
	reason?: string
): Promise<void> {
	const side = candidateSide(subject);
	await deps.db.transaction(async (tx) => {
		const now = deps.now();
		const invitation = await lockInvitation(tx, invitationId);
		if (!invitation || invitation.candidateId !== side.candidateId) throw refuse('not_found', 'not_addressee');
		const [own] = await tx
			.select({ action: consentEvents.action, documentId: consentEvents.documentId })
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
		if (own?.action !== 'grant') throw refuse('conflict', 'no_disclosure_consent');
		const [revocation] = await tx
			.insert(consentEvents)
			.values({
				subjectCandidateId: invitation.candidateId,
				kind: 'contact_disclosure',
				documentId: own.documentId,
				action: 'revoke',
				signerKind: 'subject',
				signerUserId: side.userId,
				scopeCompanyId: invitation.companyId,
				scopeInvitationId: invitation.id,
				method: 'separate_screen_button',
				evidence: {
					ip: meta.ip ?? null,
					user_agent: meta.userAgent ?? null,
					session_hash: meta.sessionHash ?? null
				},
				reason: reason?.trim() ? reason.trim() : null,
				occurredAt: now
			})
			.returning({ id: consentEvents.id });
		if (!revocation) throw new Error('consent event not inserted');
		await recordAuditEvent(tx, {
			action: 'consent.revoked',
			outcome: 'success',
			actor: auditActor(subject, meta, 'candidate'),
			object: { type: 'invitation', id: invitation.id },
			subjectCandidateId: invitation.candidateId,
			requestId: meta.requestId,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null,
			details: { kind: 'contact_disclosure', consent_event_id: revocation.id },
			occurredAt: now
		});
	});
}

// --- The legal representative's answer ------------------------------------------------------------------------------

/** What the representative reads behind the link of a disclosure letter. */
export interface RepresentativeDisclosureRequest {
	candidateName: string;
	companyName: string;
	/** The title of the offer version the candidate accepted. */
	offerTitle: string;
	salary: OfferedSalary;
	message: string | null;
	fields: DisclosureField[];
	dueAt: Date;
	/** The exact text the representative consents to. */
	document: { id: string; title: string; version: number; body: string };
}

interface LinkedRequest {
	invitation: InvitationRow;
	terms: TermsRow;
	pending: PendingRepresentativeDisclosure;
	representationId: string;
}

/**
 * The waiting acceptance of the version the link of a letter is for, or why it is not answerable any more. The
 * invitation is read by the caller: under a lock when the answer is written.
 */
async function linkedRequest(
	executor: Executor,
	terms: TermsRow,
	invitation: InvitationRow | null,
	now: Date
): Promise<LinkedRequest | { refused: string }> {
	if (!invitation || invitation.purgedAt !== null) return { refused: 'no_invitation' };
	const pending = await pendingRepresentativeDisclosure(executor, invitation, now);
	if (pending?.termsId !== terms.id) return { refused: 'request_closed' };
	const representationId = await verifiedRepresentationId(executor, invitation.candidateId);
	if (representationId === null) return { refused: 'representative_not_verified' };
	return { invitation, terms, pending, representationId };
}

async function termsOf(executor: Executor, termsId: string): Promise<TermsRow | null> {
	const [terms] = await executor.select().from(invitationTerms).where(eq(invitationTerms.id, termsId));
	return terms ?? null;
}

async function invitationOf(executor: Executor, invitationId: string): Promise<InvitationRow | null> {
	const [invitation] = await executor.select().from(invitations).where(eq(invitations.id, invitationId));
	return invitation ?? null;
}

/**
 * The invitation, its terms and the contacts a waiting acceptance hands over, for the page behind the link; `null` —
 * the link does not work (unknown, used, expired) or the acceptance does not wait any more (answered, revised, past
 * the deadline, withdrawn, revoked by the candidate).
 */
export async function representativeDisclosureRequest(
	deps: InvitationDeps,
	token: string
): Promise<RepresentativeDisclosureRequest | null> {
	const now = deps.now();
	const found = await usableEmailToken(deps.db, 'representative_disclosure', token, now);
	if (found?.targetRef == null) return null;
	const terms = await termsOf(deps.db, found.targetRef);
	if (!terms) return null;
	const linked = await linkedRequest(deps.db, terms, await invitationOf(deps.db, terms.invitationId), now);
	if ('refused' in linked) return null;
	const document = await currentDisclosureDocument(deps.db, now);
	if (!document) throw new Error('no contact_disclosure document is published');
	const [text] = await deps.db
		.select({ title: legalDocuments.title, version: legalDocuments.version, body: legalDocuments.body })
		.from(legalDocuments)
		.where(eq(legalDocuments.id, document.id));
	if (!text) throw new Error(`legal document ${document.id} disappeared`);
	const facts = await letterFacts(deps.db, linked);
	return {
		candidateName: facts.candidateName,
		companyName: facts.companyName,
		offerTitle: facts.offerTitle,
		salary: termsSalary(linked.terms),
		message: linked.terms.message,
		fields: linked.pending.fields,
		dueAt: linked.pending.dueAt,
		document: { id: document.id, ...text }
	};
}

async function letterFacts(executor: Executor, linked: LinkedRequest) {
	const [row] = await executor
		.select({ companyName: companies.displayName, candidateName: users.displayName })
		.from(invitations)
		.innerJoin(companies, eq(companies.id, invitations.companyId))
		.innerJoin(candidates, eq(candidates.id, invitations.candidateId))
		.innerJoin(users, eq(users.id, candidates.userId))
		.where(eq(invitations.id, linked.invitation.id));
	if (!row) throw new Error(`invitation ${linked.invitation.id} lost its company or candidate`);
	return {
		companyName: row.companyName,
		candidateName: row.candidateName ?? 'Кандидат',
		offerTitle: linked.terms.title
	};
}

/** The representative's answer by the link of a letter: the link is used once, the acceptance must still wait. */
async function answerByLink(
	tx: Transaction,
	token: string,
	now: Date
): Promise<LinkedRequest & { tokenId: string; vacancyStatus: string | null }> {
	const consumed = await consumeEmailToken(tx, 'representative_disclosure', token, now);
	if (consumed?.targetRef == null) throw refuse('not_found', 'invalid_link');
	const terms = await termsOf(tx, consumed.targetRef);
	if (!terms) throw refuse('not_found', 'invalid_link');
	// The vacancy of the version is locked before the offer, in the order closing the vacancy takes them.
	const vacancy = await lockVacancyOf(tx, terms.invitationId);
	const linked = await linkedRequest(tx, terms, await lockInvitation(tx, terms.invitationId), now);
	if ('refused' in linked) throw refuse('conflict', linked.refused);
	return { ...linked, tokenId: consumed.id, vacancyStatus: vacancy?.status ?? null };
}

function representativeJournal(meta: RequestMeta, invitation: InvitationRow, now: Date) {
	return {
		actor: { kind: 'anonymous' } as const,
		object: { type: 'invitation', id: invitation.id },
		subjectCandidateId: invitation.candidateId,
		requestId: meta.requestId,
		ip: meta.ip ?? null,
		userAgent: meta.userAgent ?? null,
		occurredAt: now
	};
}

async function candidateUserOf(tx: Transaction, candidateId: string): Promise<string> {
	const [row] = await tx.select({ userId: candidates.userId }).from(candidates).where(eq(candidates.id, candidateId));
	if (!row) throw new Error(`candidate ${candidateId} does not exist`);
	return row.userId;
}

/**
 * The verified legal representative of a candidate aged 14–17 consents to the disclosure the candidate chose for one
 * invitation (domain 6.3, 6.4, 13.6): the grant of the representation, then the acceptance of the version the
 * candidate accepted — disclosure record, answer and hiring process — in the same transaction. The representative
 * acts by the one-time link of the letter, not through an account; the candidate and the company are told.
 */
export async function grantDisclosureByRepresentative(
	deps: InvitationDeps,
	meta: RequestMeta,
	input: { token: string; documentId: string }
): Promise<ResponseResult> {
	return deps.db.transaction(async (tx) => {
		const now = deps.now();
		const linked = await answerByLink(tx, input.token, now);
		const { invitation, terms, pending } = linked;
		if (linked.vacancyStatus === 'closed') throw refuse('conflict', 'vacancy_closed');
		const document = await currentDisclosureDocument(tx, now);
		if (!document) throw new Error('no contact_disclosure document is published');
		if (document.id !== input.documentId) throw refuse('conflict', 'disclosure_document_changed');
		const [grant] = await tx
			.insert(consentEvents)
			.values({
				subjectCandidateId: invitation.candidateId,
				kind: 'contact_disclosure',
				documentId: document.id,
				action: 'grant',
				signerKind: 'representative',
				representationId: linked.representationId,
				scopeCompanyId: invitation.companyId,
				scopeInvitationId: invitation.id,
				scopeFields: pending.fields,
				method: 'email_link',
				evidence: {
					ip: meta.ip ?? null,
					user_agent: meta.userAgent ?? null,
					email_token_id: linked.tokenId,
					document_sha256: document.bodySha256
				},
				occurredAt: now
			})
			.returning({ id: consentEvents.id });
		if (!grant) throw new Error('consent event not inserted');
		const journal = representativeJournal(meta, invitation, now);
		await recordAuditEvent(tx, {
			...journal,
			action: 'consent.granted',
			outcome: 'success',
			details: {
				kind: 'contact_disclosure',
				consent_event_id: grant.id,
				representation_id: linked.representationId,
				fields: pending.fields
			}
		});
		const effective = await effectiveDisclosure(tx, invitation.candidateId, { invitationId: invitation.id }, now);
		if (!effective) throw new Error(`the disclosure of invitation ${invitation.id} is not in effect after both grants`);
		const candidateUserId = await candidateUserOf(tx, invitation.candidateId);
		const result = await finishAcceptance(tx, {
			invitation,
			terms,
			effective,
			grantId: pending.subjectGrantId,
			channel: 'ui',
			candidateUserId,
			journal,
			byRepresentative: true,
			now
		});
		await notify(tx, {
			userId: candidateUserId,
			type: 'invitation.representative_answered',
			objectId: invitation.id,
			stage: `v${terms.version}`,
			payload: { invitation_id: invitation.id, terms_id: terms.id, decision: 'accept' }
		});
		return result;
	});
}

/**
 * The legal representative does not consent to the disclosure: the version is declined for the candidate with
 * `representative_declined` (a previously accepted version stays accepted); the candidate and the company are told.
 */
export async function declineDisclosureByRepresentative(
	deps: InvitationDeps,
	meta: RequestMeta,
	input: { token: string }
): Promise<ResponseResult> {
	return deps.db.transaction(async (tx) => {
		const now = deps.now();
		const { invitation, terms } = await answerByLink(tx, input.token, now);
		const result = await recordDecline(
			tx,
			invitation,
			terms.id,
			{ reasonCode: REPRESENTATIVE_DECLINED, reasonText: null },
			now
		);
		await closeAnswer(tx, invitation, terms, representativeJournal(meta, invitation, now), {
			decision: 'decline',
			reasonCode: REPRESENTATIVE_DECLINED,
			byRepresentative: true
		});
		await notify(tx, {
			userId: await candidateUserOf(tx, invitation.candidateId),
			type: 'invitation.representative_answered',
			objectId: invitation.id,
			stage: `v${terms.version}`,
			payload: { invitation_id: invitation.id, terms_id: terms.id, decision: 'decline' }
		});
		return result;
	});
}

// --- Letters to the representative --------------------------------------------------------------------------------

/**
 * The letter to the verified representative about the acceptance that waits for them: the company, the vacancy, the
 * range and the contacts, with a one-time link valid until the deadline of the version.
 */
export async function sendDisclosureLetter(
	deps: RepresentativeDeps,
	meta: RequestMeta,
	actor: AuditActor,
	invitationId: string
): Promise<LetterResult> {
	const now = deps.now();
	const issued = await deps.db.transaction(async (tx) => {
		const invitation = await invitationOf(tx, invitationId);
		const terms = invitation?.currentTermsId ? await termsOf(tx, invitation.currentTermsId) : null;
		if (!terms) return null;
		const linked = await linkedRequest(tx, terms, invitation, now);
		if ('refused' in linked) return null;
		const contact = await verifiedRepresentation(tx, deps.crypto, { representationId: linked.representationId }, now);
		if (!contact) return null;
		const token = await issueEmailToken(
			tx,
			'representative_disclosure',
			{ targetRef: linked.terms.id },
			now,
			linked.pending.dueAt
		);
		return { contact, token, linked, facts: await letterFacts(tx, linked) };
	});
	if (!issued) return { ok: false, reason: 'not_applicable' };
	const { contact, token, linked, facts } = issued;
	return deliverRepresentativeLetter(deps, meta, actor, {
		kind: 'disclosure',
		contact,
		object: { type: 'invitation', id: invitationId },
		message: representativeDisclosureLetter(contact.representativeEmail, {
			representativeName: contact.representativeName,
			candidateName: facts.candidateName,
			companyName: facts.companyName,
			offerTitle: facts.offerTitle,
			salary: termsSalary(linked.terms),
			fields: linked.pending.fields,
			dueAt: linked.pending.dueAt,
			link: representativeDisclosureLink(deps.appOrigin, token)
		})
	});
}

/** The candidate asks for the letter about a waiting acceptance again: not more often than the resend interval. */
export async function resendDisclosureLetter(
	deps: RepresentativeDeps,
	meta: RequestMeta,
	subject: AccessSubject,
	invitationId: string
): Promise<LetterResult> {
	const side = candidateSide(subject);
	const invitation = await invitationOf(deps.db, invitationId);
	if (!invitation || invitation.candidateId !== side.candidateId) throw refuse('not_found', 'not_addressee');
	const pending = await pendingRepresentativeDisclosure(deps.db, invitation, deps.now());
	if (!pending) return { ok: false, reason: 'not_applicable' };
	const last = await lastEmailTokenIssuedAt(deps.db, 'representative_disclosure', pending.termsId);
	if (last !== null && deps.now().getTime() - last.getTime() < LETTER_RESEND_INTERVAL_MS) {
		return { ok: false, reason: 'too_soon' };
	}
	return sendDisclosureLetter(deps, meta, { kind: 'user', userId: side.userId }, invitationId);
}
