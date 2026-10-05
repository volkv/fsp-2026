// The legal representative of a candidate aged 14–17 signs and revokes consents without an account (docs/domain.md,
// sections 6.3, 6.4, 7.3, 19.1): once the operator verified the authority, a letter carries a one-time link to the texts
// of the consents that open the ward's profile — `pd_processing` (required), `catalog_visibility` and `fsp_import` —
// each signed on its own. The signature is a `consent_events` row of the representation with the exact version of the
// text, `email_link` as the method and the address, the browser and the link as evidence. By the same link the
// representative revokes what was signed, with the consequences the candidate's own revocation has: the catalog closes,
// the imported achievements leave the profile, and without the processing consent the profile is deleted. After each
// change a new letter says what is in force and carries a new link; the representative asks for one by the address at
// any time, the candidate in the profile. A new letter withdraws the unused link of the previous one.
import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { AccessSubject } from '$lib/server/access/permissions';
import { recordAuditEvent, type AuditActor } from '$lib/server/audit/record';
import { currentDocument, stillCurrent } from '$lib/server/auth/documents';
import {
	consumeEmailToken,
	emailTokenExpiry,
	issueEmailToken,
	lastEmailTokenIssuedAt,
	usableEmailToken
} from '$lib/server/auth/email-tokens';
import { revokeUserSessions } from '$lib/server/auth/sessions';
import { recordProfileChange } from '$lib/server/candidates/settings';
import type { FieldCrypto } from '$lib/server/crypto/fields';
import type { Database, Executor, Transaction } from '$lib/server/db';
import {
	athleteLinks,
	candidates,
	consentEvents,
	legalRepresentatives,
	representations,
	users
} from '$lib/server/db/schema';
import { ApiError } from '$lib/server/errors/api-error';
import { keepDemoLetter } from '$lib/server/demo/letters';
import { withdrawFspImport } from '$lib/server/erasure/fsp-import';
import { beginAccountDeletion } from '$lib/server/erasure/request';
import { enqueueJob } from '$lib/server/jobs/queue';
import type { Mailer } from '$lib/server/mail/mailer';
import { notify } from '$lib/server/notifications/notify';
import {
	processingRevokedByRepresentativeLetter,
	representativeConsentLetter,
	representativeConsentLink,
	representativeConsentsChangedLetter,
	representativeLetterRequestLink
} from '$lib/server/notifications/representative';
import type { Redis } from '$lib/server/redis';
import { ageBand, isMinorBand, type BirthDateInfo } from '$lib/server/visibility/age';
import { consentSides, effectiveConsentOf } from './effective';

/** What a letter to a representative needs: the database, the keys of the contacts, the mail and the links' origin. */
export interface RepresentativeDeps {
	db: Database;
	crypto: FieldCrypto;
	mailer: Mailer;
	appOrigin: string;
	now: () => Date;
}

/** Who acted, for the journal and the consent evidence. */
export interface RepresentativeMeta {
	requestId: string;
	ip?: string | null;
	userAgent?: string | null;
}

/** Consents the representative signs by the letter; `pd_processing` is the ground of the others. */
export const REPRESENTATIVE_CONSENT_KINDS = ['pd_processing', 'catalog_visibility', 'fsp_import'] as const;
export type RepresentativeConsentKind = (typeof REPRESENTATIVE_CONSENT_KINDS)[number];

/** A letter is sent again no sooner than this after the previous one. */
export const LETTER_RESEND_INTERVAL_MS = 5 * 60_000;

export interface RepresentationContact {
	representationId: string;
	candidateId: string;
	candidateUserId: string;
	candidateName: string;
	representativeName: string;
	representativeEmail: string;
}

/**
 * The verified representation of a candidate aged 14–17 whose profile is active, with the contacts of the
 * representative; `null` — there is none now (not verified, ended, the candidate is not a minor or not active).
 */
export async function verifiedRepresentation(
	executor: Executor,
	crypto: FieldCrypto,
	filter: { representationId: string } | { candidateId: string },
	now: Date
): Promise<RepresentationContact | null> {
	const [row] = await executor
		.select({
			representationId: representations.id,
			candidateId: candidates.id,
			candidateUserId: candidates.userId,
			candidateStatus: candidates.status,
			birthDate: candidates.birthDate,
			precision: candidates.birthDatePrecision,
			birthStatus: candidates.birthDateStatus,
			displayName: users.displayName,
			fullNameEnc: legalRepresentatives.fullNameEnc,
			emailEnc: legalRepresentatives.emailEnc
		})
		.from(representations)
		.innerJoin(candidates, eq(candidates.id, representations.candidateId))
		.innerJoin(users, eq(users.id, candidates.userId))
		.innerJoin(legalRepresentatives, eq(legalRepresentatives.id, representations.representativeId))
		.where(
			and(
				'representationId' in filter
					? eq(representations.id, filter.representationId)
					: eq(representations.candidateId, filter.candidateId),
				eq(representations.status, 'authority_verified')
			)
		)
		.limit(1);
	if (!row || row.candidateStatus !== 'active') return null;
	const birth: BirthDateInfo = { birthDate: row.birthDate, precision: row.precision, status: row.birthStatus };
	if (!isMinorBand(ageBand(birth, now))) return null;
	return {
		representationId: row.representationId,
		candidateId: row.candidateId,
		candidateUserId: row.candidateUserId,
		candidateName: row.displayName ?? 'Кандидат',
		representativeName: crypto.decrypt(row.fullNameEnc, 'legal_representatives.full_name'),
		representativeEmail: crypto.decrypt(row.emailEnc, 'legal_representatives.email')
	};
}

export type LetterResult = { ok: true } | { ok: false; reason: 'not_applicable' | 'too_soon' | 'not_sent' };

/**
 * Sends a letter with a new one-time link after the transaction that issued it; the journal records the send and its
 * outcome, and a letter about a candidate of a demo session is kept with the session (`demo/letters.ts`). A letter that
 * did not leave is not retried here: the candidate asks for it again.
 */
export async function deliverRepresentativeLetter(
	deps: RepresentativeDeps,
	meta: RepresentativeMeta,
	actor: AuditActor,
	letter: {
		kind: 'consents' | 'disclosure';
		contact: RepresentationContact;
		object: { type: string; id: string };
		message: Parameters<Mailer['send']>[0];
	}
): Promise<LetterResult> {
	const sent = await deps.mailer.send(letter.message);
	await recordAuditEvent(deps.db, {
		action: 'representation.letter_sent',
		outcome: sent.ok ? 'success' : 'failure',
		actor,
		object: letter.object,
		subjectCandidateId: letter.contact.candidateId,
		requestId: meta.requestId,
		ip: meta.ip ?? null,
		userAgent: meta.userAgent ?? null,
		details: {
			kind: letter.kind,
			representation_id: letter.contact.representationId,
			...(sent.ok ? {} : { error: sent.error.code })
		}
	});
	if (!sent.ok) {
		console.error(`[representative] ${letter.kind} letter not sent: ${sent.error.code} ${sent.error.message}`);
		return { ok: false, reason: 'not_sent' };
	}
	// A candidate of a demo session: the visitor reads the letter on the letters page of the session.
	await keepDemoLetter(deps.db, deps.crypto, {
		candidateId: letter.contact.candidateId,
		kind: letter.kind,
		object: letter.object,
		message: letter.message
	});
	return { ok: true };
}

type ConsentLetterOf = (
	contact: RepresentationContact,
	link: { href: string; requestHref: string; expiresAt: Date },
	now: Date
) => Promise<Parameters<Mailer['send']>[0]>;

/**
 * Issues a new consents link of the representation — the unused link of the previous letter stops working — and sends
 * the letter `compose` writes around it.
 */
async function sendConsentsLink(
	deps: RepresentativeDeps,
	meta: RepresentativeMeta,
	actor: AuditActor,
	representationId: string,
	compose: ConsentLetterOf
): Promise<LetterResult> {
	const now = deps.now();
	const issued = await deps.db.transaction(async (tx) => {
		const contact = await verifiedRepresentation(tx, deps.crypto, { representationId }, now);
		if (!contact) return null;
		const token = await issueEmailToken(tx, 'representative_consent', { targetRef: representationId }, now);
		return { contact, token };
	});
	if (!issued) return { ok: false, reason: 'not_applicable' };
	const { contact, token } = issued;
	const message = await compose(
		contact,
		{
			href: representativeConsentLink(deps.appOrigin, token),
			requestHref: representativeLetterRequestLink(deps.appOrigin),
			expiresAt: emailTokenExpiry('representative_consent', now)
		},
		now
	);
	return deliverRepresentativeLetter(deps, meta, actor, {
		kind: 'consents',
		contact,
		object: { type: 'representation', id: representationId },
		message
	});
}

/**
 * The letter with the consents to sign, to the representative whose authority is verified. Sent after the operator's
 * verification and again at the candidate's or the representative's request; the new link withdraws the unused one of
 * the previous letter.
 */
export async function sendConsentLetter(
	deps: RepresentativeDeps,
	meta: RepresentativeMeta,
	actor: AuditActor,
	representationId: string
): Promise<LetterResult> {
	return sendConsentsLink(deps, meta, actor, representationId, (contact, link) =>
		Promise.resolve(
			representativeConsentLetter(contact.representativeEmail, {
				representativeName: contact.representativeName,
				candidateName: contact.candidateName,
				link: link.href,
				requestLink: link.requestHref,
				expiresAt: link.expiresAt
			})
		)
	);
}

/** After the representative signed or revoked: what is in force on their side now, with a new link. */
function sendConsentsChangedLetter(
	deps: RepresentativeDeps,
	meta: RepresentativeMeta,
	representationId: string,
	change: 'signed' | 'revoked'
): Promise<LetterResult> {
	return sendConsentsLink(deps, meta, { kind: 'anonymous' }, representationId, async (contact, link, now) => {
		const sides = await consentSides(
			deps.db,
			contact.candidateId,
			REPRESENTATIVE_CONSENT_KINDS,
			contact.representationId,
			now
		);
		const inForce = (kind: RepresentativeConsentKind) => sides.get(kind)?.representative != null;
		return representativeConsentsChangedLetter(contact.representativeEmail, {
			representativeName: contact.representativeName,
			candidateName: contact.candidateName,
			change,
			inForce: {
				pd_processing: inForce('pd_processing'),
				catalog_visibility: inForce('catalog_visibility'),
				fsp_import: inForce('fsp_import')
			},
			link: link.href,
			requestLink: link.requestHref,
			expiresAt: link.expiresAt
		});
	});
}

/** The candidate asks for the consents letter again: not more often than `LETTER_RESEND_INTERVAL_MS`. */
export async function resendConsentLetter(
	deps: RepresentativeDeps,
	meta: RepresentativeMeta,
	subject: AccessSubject
): Promise<LetterResult> {
	const candidateId = subject.candidate?.id;
	if (candidateId === undefined || subject.userId === null) throw new ApiError('forbidden');
	const now = deps.now();
	const contact = await verifiedRepresentation(deps.db, deps.crypto, { candidateId }, now);
	if (!contact) return { ok: false, reason: 'not_applicable' };
	const last = await lastEmailTokenIssuedAt(deps.db, 'representative_consent', contact.representationId);
	if (last !== null && now.getTime() - last.getTime() < LETTER_RESEND_INTERVAL_MS)
		return { ok: false, reason: 'too_soon' };
	return sendConsentLetter(deps, meta, { kind: 'user', userId: subject.userId }, contact.representationId);
}

const emailSchema = z.email().max(254);

/**
 * The representative asks for a new consents letter by the address, without an account: every verified
 * representation of a minor under that address gets one, not more often than `LETTER_RESEND_INTERVAL_MS`. The answer
 * is the same for every address — the page does not tell whom the platform knows.
 *
 * `demoSessionId` is the demo session of the browser that asks (`null` — none): the person of a representative is
 * shared by the clones of every session (the clone plan), so the letters go to the representations of the candidates
 * of that session only, and a request outside sessions reaches the candidates outside sessions only. A new letter
 * withdraws the unused link of the previous one: without the bound a visitor of one session would void the links
 * another session is about to open.
 */
export async function requestConsentLetterByRepresentative(
	deps: RepresentativeDeps,
	meta: RepresentativeMeta,
	email: string,
	demoSessionId: string | null
): Promise<void> {
	const address = email.trim();
	if (!emailSchema.safeParse(address).success) return;
	const rows = await deps.db
		.select({ id: representations.id })
		.from(representations)
		.innerJoin(legalRepresentatives, eq(legalRepresentatives.id, representations.representativeId))
		.innerJoin(candidates, eq(candidates.id, representations.candidateId))
		.where(
			and(
				eq(legalRepresentatives.emailHmac, deps.crypto.lookupHmac('email', address)),
				eq(representations.status, 'authority_verified'),
				demoSessionId === null ? isNull(candidates.demoSessionId) : eq(candidates.demoSessionId, demoSessionId)
			)
		);
	const now = deps.now();
	for (const { id } of rows) {
		const last = await lastEmailTokenIssuedAt(deps.db, 'representative_consent', id);
		if (last !== null && now.getTime() - last.getTime() < LETTER_RESEND_INTERVAL_MS) continue;
		await sendConsentLetter(deps, meta, { kind: 'anonymous' }, id);
	}
}

// --- The representative's page ------------------------------------------------------------------------------------

export interface RepresentativeConsentText {
	kind: RepresentativeConsentKind;
	id: string;
	title: string;
	version: number;
	body: string;
	/** The representative's signature under this kind is in force. */
	signed: boolean;
	/** The candidate's own signature is in force: the consent works once both have signed. */
	candidateSigned: boolean;
}

export interface RepresentativeConsentForm {
	candidateName: string;
	representativeName: string;
	texts: RepresentativeConsentText[];
}

/** What the page behind the link shows; `null` — the link does not work (unknown, used, expired, no longer verified). */
export async function representativeConsentForm(
	db: Database,
	crypto: FieldCrypto,
	token: string,
	now: Date
): Promise<RepresentativeConsentForm | null> {
	const found = await usableEmailToken(db, 'representative_consent', token, now);
	if (found?.targetRef == null) return null;
	const contact = await verifiedRepresentation(db, crypto, { representationId: found.targetRef }, now);
	if (!contact) return null;
	const sides = await consentSides(
		db,
		contact.candidateId,
		REPRESENTATIVE_CONSENT_KINDS,
		contact.representationId,
		now
	);
	const texts: RepresentativeConsentText[] = [];
	for (const kind of REPRESENTATIVE_CONSENT_KINDS) {
		const document = await currentDocument(db, kind, now);
		if (!document?.available) continue;
		const side = sides.get(kind);
		texts.push({
			kind,
			id: document.id,
			title: document.title,
			version: document.version,
			body: document.body,
			signed: side?.representative != null,
			candidateSigned: side?.subject != null
		});
	}
	return { candidateName: contact.candidateName, representativeName: contact.representativeName, texts };
}

export type SignResult =
	/** `letterSent` — the letter with what is in force and a new link left. */
	| { ok: true; signed: RepresentativeConsentKind[]; letterSent: boolean }
	| { ok: false; reason: 'invalid_link' | 'nothing_chosen' | 'processing_required' | 'document_changed' };

type SignRefusal = Exclude<SignResult, { ok: true }>['reason'];

class SignRefused extends Error {
	override name = 'SignRefused';
	readonly reason: SignRefusal;

	constructor(reason: SignRefusal) {
		super(reason);
		this.reason = reason;
	}
}

/**
 * The representative signs the chosen consents by the link: each is a `grant` of the representation naming the version
 * of the text the page showed. `pd_processing` is required unless already signed. The link works once; a refusal keeps
 * it working. The candidate is notified; processing, the catalog and the import start by the product's own rules. After
 * the commit the representative gets a letter with what is in force and a new link to change it.
 */
export async function signConsentsByRepresentative(
	deps: RepresentativeDeps,
	meta: RepresentativeMeta,
	token: string,
	chosen: Partial<Record<RepresentativeConsentKind, string>>
): Promise<SignResult> {
	const now = deps.now();
	try {
		const signed = await deps.db.transaction(async (tx) => {
			const consumed = await consumeEmailToken(tx, 'representative_consent', token, now);
			if (consumed?.targetRef == null) throw new SignRefused('invalid_link');
			const [locked] = await tx
				.select({ id: representations.id })
				.from(representations)
				.where(eq(representations.id, consumed.targetRef))
				.for('update');
			if (!locked) throw new SignRefused('invalid_link');
			const contact = await verifiedRepresentation(tx, deps.crypto, { representationId: locked.id }, now);
			if (!contact) throw new SignRefused('invalid_link');
			const kinds = REPRESENTATIVE_CONSENT_KINDS.filter((kind) => chosen[kind] !== undefined);
			if (kinds.length === 0) throw new SignRefused('nothing_chosen');
			const sides = await consentSides(tx, contact.candidateId, ['pd_processing'], contact.representationId, now);
			if (!kinds.includes('pd_processing') && sides.get('pd_processing')?.representative == null) {
				throw new SignRefused('processing_required');
			}
			for (const kind of kinds) {
				const documentId = chosen[kind];
				const document = documentId === undefined ? null : await stillCurrent(tx, kind, documentId, now);
				if (!document?.available) throw new SignRefused('document_changed');
				const [grant] = await tx
					.insert(consentEvents)
					.values({
						subjectCandidateId: contact.candidateId,
						kind,
						documentId: document.id,
						action: 'grant',
						signerKind: 'representative',
						representationId: contact.representationId,
						method: 'email_link',
						evidence: {
							ip: meta.ip ?? null,
							user_agent: meta.userAgent ?? null,
							email_token_id: consumed.id,
							document_sha256: document.bodySha256
						},
						occurredAt: now
					})
					.returning({ id: consentEvents.id });
				if (!grant) throw new Error('consent event was not inserted');
				await recordAuditEvent(tx, {
					action: 'consent.granted',
					outcome: 'success',
					actor: { kind: 'anonymous' },
					object: { type: 'consent_event', id: grant.id },
					subjectCandidateId: contact.candidateId,
					requestId: meta.requestId,
					ip: meta.ip ?? null,
					userAgent: meta.userAgent ?? null,
					details: { kind, document_version: document.version, representation_id: contact.representationId },
					occurredAt: now
				});
				if (kind === 'fsp_import') await startImport(tx, contact, grant.id, now);
			}
			// The profile is processed from now on (or with another scope): the categorization and the matches catch up.
			await recordProfileChange(tx, contact.candidateId, {
				evidenceInput: kinds.includes('pd_processing'),
				createdBy: { kind: 'system' }
			});
			await notify(tx, {
				userId: contact.candidateUserId,
				type: 'representation.consents_signed',
				objectId: contact.representationId,
				stage: consumed.id,
				payload: { representation_id: contact.representationId }
			});
			return { kinds, representationId: contact.representationId };
		});
		const letter = await sendConsentsChangedLetter(deps, meta, signed.representationId, 'signed');
		return { ok: true, signed: signed.kinds, letterSent: letter.ok };
	} catch (error) {
		if (error instanceof SignRefused) return { ok: false, reason: error.reason };
		throw error;
	}
}

/** With both sides of `fsp_import` in effect, the achievements of the ward's linked athlete are synchronized. */
async function startImport(tx: Transaction, contact: RepresentationContact, grantId: string, now: Date): Promise<void> {
	if ((await effectiveConsentOf(tx, contact.candidateId, 'fsp_import', now)) === null) return;
	const links = await tx
		.select({ id: athleteLinks.id })
		.from(athleteLinks)
		.where(and(eq(athleteLinks.userId, contact.candidateUserId), eq(athleteLinks.status, 'active')));
	for (const link of links) {
		await enqueueJob(
			tx,
			'fsp.sync',
			{ athlete_link_id: link.id },
			{ inputVersion: `${link.id}:${grantId}`, createdBy: { kind: 'system' } }
		);
	}
}

// --- Revocation by the representative -----------------------------------------------------------------------------

export type RevokeResult =
	| {
			ok: true;
			revoked: RepresentativeConsentKind[];
			/** The processing consent was revoked: the profile of the ward is being deleted (domain 19.1). */
			profileDeleted: boolean;
			/** The letter that follows left: to the representative with a new link, or to the ward about the deletion. */
			letterSent: boolean;
	  }
	| { ok: false; reason: 'invalid_link' | 'nothing_chosen' | 'not_signed' | 'deletion_refused' };

type RevokeRefusal = Exclude<RevokeResult, { ok: true }>['reason'];

class RevokeRefused extends Error {
	override name = 'RevokeRefused';
	readonly reason: RevokeRefusal;

	constructor(reason: RevokeRefusal) {
		super(reason);
		this.reason = reason;
	}
}

/** The last grant of the kind signed by the representation: the document the revocation names. */
async function lastRepresentativeGrant(
	tx: Transaction,
	contact: RepresentationContact,
	kind: RepresentativeConsentKind
): Promise<{ documentId: string }> {
	const [row] = await tx
		.select({ documentId: consentEvents.documentId })
		.from(consentEvents)
		.where(
			and(
				eq(consentEvents.subjectCandidateId, contact.candidateId),
				eq(consentEvents.kind, kind),
				eq(consentEvents.representationId, contact.representationId),
				eq(consentEvents.action, 'grant')
			)
		)
		.orderBy(desc(consentEvents.occurredAt), desc(consentEvents.id))
		.limit(1);
	if (!row) throw new Error(`representation ${contact.representationId} has no grant of ${kind}`);
	return row;
}

/**
 * The representative revokes chosen consents by the link: a `revoke` of the representation for each one whose
 * signature is in force — the consent stops for both sides (domain 6.3) — with the consequences the candidate's own
 * revocation has (domain 19.1), in the same transaction:
 * - `catalog_visibility` — the profile leaves the catalog (`visibility = hidden`), the counters are recomputed;
 * - `fsp_import` — the imports stop, the imported facts leave the profile, `consent.revocation_cleanup` is enqueued;
 * - `pd_processing` — the deletion of the ward's account (`processing_revoked`): without the processing consent the
 *   profile is not kept.
 * Kinds not signed now are skipped; when none is, nothing changes (`not_signed`) — a repeated revocation writes
 * nothing. The link works once; a refusal keeps it working. The candidate is notified; after a deletion the ward's
 * sessions end and the ward gets the letter about it, otherwise the representative gets a new link.
 */
export async function revokeConsentsByRepresentative(
	deps: RepresentativeDeps & { redis: Redis },
	meta: RepresentativeMeta,
	token: string,
	chosen: readonly string[]
): Promise<RevokeResult> {
	const now = deps.now();
	let outcome: {
		kinds: RepresentativeConsentKind[];
		contact: RepresentationContact;
		deletedEmailEnc: Uint8Array | null;
	};
	try {
		outcome = await deps.db.transaction(async (tx) => {
			const consumed = await consumeEmailToken(tx, 'representative_consent', token, now);
			if (consumed?.targetRef == null) throw new RevokeRefused('invalid_link');
			const [locked] = await tx
				.select({ id: representations.id })
				.from(representations)
				.where(eq(representations.id, consumed.targetRef))
				.for('update');
			if (!locked) throw new RevokeRefused('invalid_link');
			const contact = await verifiedRepresentation(tx, deps.crypto, { representationId: locked.id }, now);
			if (!contact) throw new RevokeRefused('invalid_link');
			const asked = REPRESENTATIVE_CONSENT_KINDS.filter((kind) => chosen.includes(kind));
			if (asked.length === 0) throw new RevokeRefused('nothing_chosen');
			const sides = await consentSides(tx, contact.candidateId, asked, contact.representationId, now);
			const kinds = asked.filter((kind) => sides.get(kind)?.representative != null);
			if (kinds.length === 0) throw new RevokeRefused('not_signed');

			const revocations = new Map<RepresentativeConsentKind, string>();
			for (const kind of kinds) {
				const grant = await lastRepresentativeGrant(tx, contact, kind);
				const [revocation] = await tx
					.insert(consentEvents)
					.values({
						subjectCandidateId: contact.candidateId,
						kind,
						documentId: grant.documentId,
						action: 'revoke',
						signerKind: 'representative',
						representationId: contact.representationId,
						method: 'email_link',
						evidence: { ip: meta.ip ?? null, user_agent: meta.userAgent ?? null, email_token_id: consumed.id },
						occurredAt: now
					})
					.returning({ id: consentEvents.id });
				if (!revocation) throw new Error('consent event was not inserted');
				revocations.set(kind, revocation.id);
				await recordAuditEvent(tx, {
					action: 'consent.revoked',
					outcome: 'success',
					actor: { kind: 'anonymous' },
					object: { type: 'consent_event', id: revocation.id },
					subjectCandidateId: contact.candidateId,
					requestId: meta.requestId,
					ip: meta.ip ?? null,
					userAgent: meta.userAgent ?? null,
					details: { kind, representation_id: contact.representationId },
					occurredAt: now
				});
			}

			if (revocations.has('pd_processing')) {
				// The revocation recorded above is the last event of the kind: the deletion does not revoke it again.
				const [account] = await tx
					.select({ emailEnc: users.emailEnc })
					.from(users)
					.where(eq(users.id, contact.candidateUserId));
				const refusal = await beginAccountDeletion(tx, {
					userId: contact.candidateUserId,
					cause: 'processing_revoked',
					actor: { kind: 'anonymous' },
					requestId: meta.requestId,
					ip: meta.ip ?? null,
					userAgent: meta.userAgent ?? null,
					at: now
				});
				if (refusal) {
					console.error(`[representative] the deletion of the ward was refused: ${refusal.reason}`);
					throw new RevokeRefused('deletion_refused');
				}
				return { kinds, contact, deletedEmailEnc: account?.emailEnc ?? null };
			}

			const fspRevocation = revocations.get('fsp_import');
			if (fspRevocation !== undefined) {
				await withdrawFspImport(tx, {
					candidateId: contact.candidateId,
					userId: contact.candidateUserId,
					revocationId: fspRevocation,
					at: now,
					actor: { kind: 'anonymous' },
					requestId: meta.requestId,
					createdBy: { kind: 'system' }
				});
			}
			if (revocations.has('catalog_visibility')) {
				await tx
					.update(candidates)
					.set({ visibility: 'hidden' })
					.where(and(eq(candidates.id, contact.candidateId), eq(candidates.visibility, 'catalog')));
				await recordProfileChange(tx, contact.candidateId, {
					evidenceInput: false,
					createdBy: { kind: 'system' }
				});
			}
			await notify(tx, {
				userId: contact.candidateUserId,
				type: 'representation.consents_revoked',
				objectId: contact.representationId,
				stage: consumed.id,
				payload: {
					representation_id: contact.representationId,
					catalog_visibility: revocations.has('catalog_visibility'),
					fsp_import: revocations.has('fsp_import')
				}
			});
			return { kinds, contact, deletedEmailEnc: null };
		});
	} catch (error) {
		if (error instanceof RevokeRefused) return { ok: false, reason: error.reason };
		throw error;
	}

	if (!outcome.kinds.includes('pd_processing')) {
		const letter = await sendConsentsChangedLetter(deps, meta, outcome.contact.representationId, 'revoked');
		return { ok: true, revoked: outcome.kinds, profileDeleted: false, letterSent: letter.ok };
	}
	await revokeUserSessions(deps.redis, outcome.contact.candidateUserId);
	if (outcome.deletedEmailEnc === null) {
		return { ok: true, revoked: outcome.kinds, profileDeleted: true, letterSent: false };
	}
	const sent = await deps.mailer.send(
		processingRevokedByRepresentativeLetter(deps.crypto.decrypt(outcome.deletedEmailEnc, 'users.email'))
	);
	if (!sent.ok) {
		console.error(
			`[representative] the deletion letter to the ward not sent: ${sent.error.code} ${sent.error.message}`
		);
	}
	return { ok: true, revoked: outcome.kinds, profileDeleted: true, letterSent: sent.ok };
}

// --- The candidate's view -----------------------------------------------------------------------------------------

export interface RepresentativeOverview {
	/** The representation that is not ended, if any. */
	representation: { id: string; status: Exclude<(typeof representations.$inferSelect)['status'], 'ended'> } | null;
	/** By kind: the candidate's side, the representative's side and whether the consent works. */
	consents: { kind: RepresentativeConsentKind; candidate: boolean; representative: boolean; effective: boolean }[];
	/** The last consents letter and when the next one may be asked for; `null` — no letter was sent. */
	letter: { sentAt: Date; nextAt: Date } | null;
}

export async function representativeOverview(
	executor: Executor,
	candidateId: string,
	now: Date
): Promise<RepresentativeOverview> {
	const [representation] = await executor
		.select({ id: representations.id, status: representations.status })
		.from(representations)
		.where(and(eq(representations.candidateId, candidateId), ne(representations.status, 'ended')))
		.orderBy(desc(representations.invitedAt))
		.limit(1);
	const verifiedId = representation?.status === 'authority_verified' ? representation.id : null;
	const sides = await consentSides(executor, candidateId, REPRESENTATIVE_CONSENT_KINDS, verifiedId, now);
	const sentAt = verifiedId ? await lastEmailTokenIssuedAt(executor, 'representative_consent', verifiedId) : null;
	return {
		representation:
			representation && representation.status !== 'ended'
				? { id: representation.id, status: representation.status }
				: null,
		consents: REPRESENTATIVE_CONSENT_KINDS.map((kind) => {
			const side = sides.get(kind);
			return {
				kind,
				candidate: side?.subject != null,
				representative: side?.representative != null,
				effective: side?.effective === true
			};
		}),
		letter: sentAt ? { sentAt, nextAt: new Date(sentAt.getTime() + LETTER_RESEND_INTERVAL_MS) } : null
	};
}
