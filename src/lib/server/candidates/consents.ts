// The candidate's own consents of the cabinet (docs/domain.md, sections 6.3, 7.3, 7.4, 19.1): showing the profile in
// the catalog of verified companies with the extra blocks an adult may add (`scope_fields`), the Telegram channel
// of notifications, the revocation of the import of FSP achievements, and the pool of the partners of each competition
// where the candidate is a finalist (domain 5.5). Each grant is on its own screen and names the exact version of the
// text; a revocation acts at once. Consents to disclose contacts are given and revoked by invitation
// (`$lib/server/invitations`).
import { and, asc, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import { can, type AccessSubject } from '$lib/server/access/permissions';
import { recordAuditEvent } from '$lib/server/audit/record';
import { currentDocument, stillCurrent, type CurrentDocument } from '$lib/server/auth/documents';
import { ownProcessingConsent } from '$lib/server/auth/onboarding';
import { effectiveConsentOf } from '$lib/server/consent/effective';
import { processingAllowed } from '$lib/server/consent/processing';
import { CATALOG_SCOPE_FIELDS, type CatalogScopeField, type DisclosureField } from '$lib/server/consent/kinds';
import type { Database, Executor, Transaction } from '$lib/server/db';
import {
	candidates,
	companies,
	consentEvents,
	disclosures,
	invitations,
	invitationTerms,
	notificationChannels,
	representations,
	sourceFacts
} from '$lib/server/db/schema';
import { openPartnerships, type OpenPartnership } from '$lib/server/companies/partnerships';
import { withdrawFspImport } from '$lib/server/erasure/fsp-import';
import { ApiError, policyViolation } from '$lib/server/errors/api-error';
import { auditActor, type RequestMeta } from '$lib/server/invitations/deps';
import { effectiveDisclosure } from '$lib/server/invitations/consent';
import type { VacancySnapshot } from '$lib/server/invitations/terms';
import { loadVisibilityFacts, loadVisibilityPolicy } from '$lib/server/matching/visibility';
import { effectiveTelegramConsent } from '$lib/server/notifications/consent';
import { unlinkTelegramChannel } from '$lib/server/notifications/telegram';
import {
	competitionResults,
	effectivePoolGrants,
	fitsPoolRule,
	poolChoicesSchema,
	type CompetitionResult,
	type PoolChoices
} from '$lib/server/partner-pool/membership';
import { ageBand, isMinorBand } from '$lib/server/visibility/age';
import { recordProfileChange } from './settings';

type ConsentKind = 'catalog_visibility' | 'telegram_notifications' | 'fsp_import' | 'partner_pool';

function writableCandidate(subject: AccessSubject): { candidateId: string; userId: string } {
	const candidateId = subject.candidate?.id;
	if (candidateId === undefined || subject.userId === null) throw new ApiError('forbidden');
	const access = can(subject, 'candidate.self.write', { candidateId });
	if (!access.allowed) throw new ApiError(access.reason === 'unauthenticated' ? 'unauthenticated' : 'forbidden');
	return { candidateId, userId: subject.userId };
}

/** The last event the candidate signed of the kind; `grant` means the subject's side of the consent is given. */
async function lastSubjectEvent(executor: Executor, candidateId: string, kind: ConsentKind) {
	const [row] = await executor
		.select({
			id: consentEvents.id,
			action: consentEvents.action,
			documentId: consentEvents.documentId,
			scopeFields: consentEvents.scopeFields,
			occurredAt: consentEvents.occurredAt
		})
		.from(consentEvents)
		.where(
			and(
				eq(consentEvents.subjectCandidateId, candidateId),
				eq(consentEvents.kind, kind),
				eq(consentEvents.signerKind, 'subject')
			)
		)
		.orderBy(desc(consentEvents.occurredAt), desc(consentEvents.id))
		.limit(1);
	return row ?? null;
}

async function representativeVerified(executor: Executor, candidateId: string): Promise<boolean> {
	const [row] = await executor
		.select({ id: representations.id })
		.from(representations)
		.where(and(eq(representations.candidateId, candidateId), eq(representations.status, 'authority_verified')))
		.limit(1);
	return row !== undefined;
}

async function lockedCandidate(tx: Transaction, candidateId: string) {
	const [row] = await tx
		.select({
			status: candidates.status,
			birthDate: candidates.birthDate,
			precision: candidates.birthDatePrecision,
			birthStatus: candidates.birthDateStatus
		})
		.from(candidates)
		.where(eq(candidates.id, candidateId))
		.for('update');
	if (row?.status !== 'active') throw new ApiError('not_found');
	return row;
}

async function currentText(tx: Transaction, kind: ConsentKind, documentId: string, now: Date) {
	const document = await stillCurrent(tx, kind, documentId, now);
	if (!document?.available) {
		throw new ApiError('conflict', { message: 'Текст согласия обновился — прочитайте новую редакцию' });
	}
	return document;
}

function evidenceOf(meta: RequestMeta, document?: CurrentDocument) {
	return {
		ip: meta.ip ?? null,
		user_agent: meta.userAgent ?? null,
		session_hash: meta.sessionHash ?? null,
		...(document ? { document_sha256: document.bodySha256 } : {})
	};
}

/**
 * The candidate shows the profile in the catalog of verified companies, or changes what an adult adds to the catalog
 * card: a new `grant` of `catalog_visibility` with the chosen `scope_fields`, and the setting `visibility = catalog`.
 * Narrowing acts at once (domain 6.3). Aged 14–17: no extra blocks at all (`422 scope_fields_minor`), and the profile
 * stays hidden until a representative's authority is verified (domain 7.3).
 */
export async function grantCatalogVisibility(
	db: Database,
	subject: AccessSubject,
	meta: RequestMeta,
	input: { documentId: string; scopeFields: readonly string[] }
): Promise<void> {
	const { candidateId, userId } = writableCandidate(subject);
	const scopeFields = CATALOG_SCOPE_FIELDS.filter((field) => input.scopeFields.includes(field));
	if (scopeFields.length !== new Set(input.scopeFields).size) {
		throw new ApiError('validation_failed', {
			details: [{ path: 'scope_fields', code: 'unknown', message: 'Неизвестный блок карточки' }]
		});
	}
	await db.transaction(async (tx) => {
		const now = new Date();
		const candidate = await lockedCandidate(tx, candidateId);
		const band = ageBand(
			{ birthDate: candidate.birthDate, precision: candidate.precision, status: candidate.birthStatus },
			now
		);
		if (band === 'unknown' || band === 'under_14') {
			throw new ApiError('forbidden', { message: 'Возраст не подтверждён: показ в каталоге недоступен' });
		}
		if (isMinorBand(band)) {
			if (scopeFields.length > 0) throw policyViolation('scope_fields_minor', 'scope_fields');
			if (!(await representativeVerified(tx, candidateId))) {
				throw new ApiError('conflict', {
					message: 'Показ в каталоге станет доступен после подтверждения представителя'
				});
			}
		}
		const document = await currentText(tx, 'catalog_visibility', input.documentId, now);
		const [grant] = await tx
			.insert(consentEvents)
			.values({
				subjectCandidateId: candidateId,
				kind: 'catalog_visibility',
				documentId: document.id,
				action: 'grant',
				signerKind: 'subject',
				signerUserId: userId,
				scopeFields: scopeFields.length > 0 ? scopeFields : null,
				method: 'separate_screen_button',
				evidence: evidenceOf(meta, document),
				occurredAt: now
			})
			.returning({ id: consentEvents.id });
		if (!grant) throw new Error('consent event was not inserted');
		await tx.update(candidates).set({ visibility: 'catalog' }).where(eq(candidates.id, candidateId));
		await recordAuditEvent(tx, {
			action: 'consent.granted',
			outcome: 'success',
			actor: auditActor(subject, meta, 'candidate'),
			object: { type: 'consent_event', id: grant.id },
			subjectCandidateId: candidateId,
			requestId: meta.requestId,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null,
			details: { kind: 'catalog_visibility', document_version: document.version, scope_fields: scopeFields },
			occurredAt: now
		});
		await recordProfileChange(tx, candidateId, { evidenceInput: false, createdBy: { kind: 'user', id: userId } });
	});
}

/**
 * The candidate stops showing the profile in the catalog: a `revoke` of `catalog_visibility` and `visibility = hidden`.
 * The candidate leaves the search and the counters at once; contacts already disclosed stay with their companies
 * (domain 19.1).
 */
export async function revokeCatalogVisibility(
	db: Database,
	subject: AccessSubject,
	meta: RequestMeta,
	reason?: string
): Promise<void> {
	const { candidateId, userId } = writableCandidate(subject);
	await db.transaction(async (tx) => {
		const now = new Date();
		await lockedCandidate(tx, candidateId);
		const last = await lastSubjectEvent(tx, candidateId, 'catalog_visibility');
		if (last?.action !== 'grant') throw new ApiError('conflict', { message: 'Показ в каталоге уже выключен' });
		const [revocation] = await tx
			.insert(consentEvents)
			.values({
				subjectCandidateId: candidateId,
				kind: 'catalog_visibility',
				documentId: last.documentId,
				action: 'revoke',
				signerKind: 'subject',
				signerUserId: userId,
				method: 'separate_screen_button',
				evidence: evidenceOf(meta),
				reason: reason?.trim() ? reason.trim() : null,
				occurredAt: now
			})
			.returning({ id: consentEvents.id });
		if (!revocation) throw new Error('consent event was not inserted');
		await tx.update(candidates).set({ visibility: 'hidden' }).where(eq(candidates.id, candidateId));
		await recordAuditEvent(tx, {
			action: 'consent.revoked',
			outcome: 'success',
			actor: auditActor(subject, meta, 'candidate'),
			object: { type: 'consent_event', id: revocation.id },
			subjectCandidateId: candidateId,
			requestId: meta.requestId,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null,
			details: { kind: 'catalog_visibility' },
			occurredAt: now
		});
		await recordProfileChange(tx, candidateId, { evidenceInput: false, createdBy: { kind: 'user', id: userId } });
	});
}

/** The consent to notifications in Telegram: the ground of linking the bot (contracts 7.2). */
export async function grantTelegramConsent(
	db: Database,
	subject: AccessSubject,
	meta: RequestMeta,
	documentId: string
): Promise<void> {
	const { candidateId, userId } = writableCandidate(subject);
	await db.transaction(async (tx) => {
		const now = new Date();
		await lockedCandidate(tx, candidateId);
		const document = await currentText(tx, 'telegram_notifications', documentId, now);
		const [grant] = await tx
			.insert(consentEvents)
			.values({
				subjectCandidateId: candidateId,
				kind: 'telegram_notifications',
				documentId: document.id,
				action: 'grant',
				signerKind: 'subject',
				signerUserId: userId,
				method: 'separate_screen_button',
				evidence: evidenceOf(meta, document),
				occurredAt: now
			})
			.returning({ id: consentEvents.id });
		if (!grant) throw new Error('consent event was not inserted');
		await recordAuditEvent(tx, {
			action: 'consent.granted',
			outcome: 'success',
			actor: auditActor(subject, meta, 'candidate'),
			object: { type: 'consent_event', id: grant.id },
			subjectCandidateId: candidateId,
			requestId: meta.requestId,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null,
			details: { kind: 'telegram_notifications', document_version: document.version },
			occurredAt: now
		});
	});
}

/** Revoking the Telegram consent ends the channel and erases the chat id in the same transaction (domain 19.1). */
export async function revokeTelegramConsent(db: Database, subject: AccessSubject, meta: RequestMeta): Promise<void> {
	const { candidateId, userId } = writableCandidate(subject);
	await db.transaction(async (tx) => {
		const now = new Date();
		await lockedCandidate(tx, candidateId);
		const last = await lastSubjectEvent(tx, candidateId, 'telegram_notifications');
		if (last?.action !== 'grant') throw new ApiError('conflict', { message: 'Согласие на Telegram не дано' });
		const [revocation] = await tx
			.insert(consentEvents)
			.values({
				subjectCandidateId: candidateId,
				kind: 'telegram_notifications',
				documentId: last.documentId,
				action: 'revoke',
				signerKind: 'subject',
				signerUserId: userId,
				method: 'separate_screen_button',
				evidence: evidenceOf(meta),
				occurredAt: now
			})
			.returning({ id: consentEvents.id });
		if (!revocation) throw new Error('consent event was not inserted');
		const actor = auditActor(subject, meta, 'candidate');
		const channels = await tx
			.select({ id: notificationChannels.id })
			.from(notificationChannels)
			.where(
				and(
					eq(notificationChannels.userId, userId),
					eq(notificationChannels.kind, 'telegram'),
					eq(notificationChannels.status, 'active')
				)
			);
		for (const channel of channels) {
			await unlinkTelegramChannel(tx, channel.id, { reason: 'no_consent', now, actor, meta });
		}
		await recordAuditEvent(tx, {
			action: 'consent.revoked',
			outcome: 'success',
			actor,
			object: { type: 'consent_event', id: revocation.id },
			subjectCandidateId: candidateId,
			requestId: meta.requestId,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null,
			details: { kind: 'telegram_notifications' },
			occurredAt: now
		});
	});
}

/**
 * The candidate revokes the import of FSP achievements (domain 19.1): a `revoke` of `fsp_import`, and in the same
 * transaction the imports stop and the imported facts leave the profile — their receipts answer `not_valid` at once;
 * `consent.revocation_cleanup` removes them physically. Revoking one side ends the consent for a minor as well: a
 * representative's grant does not act without the candidate's own (domain 6.3). Returns how many facts left.
 */
export async function revokeFspImportConsent(
	db: Database,
	subject: AccessSubject,
	meta: RequestMeta,
	reason?: string
): Promise<number> {
	const { candidateId, userId } = writableCandidate(subject);
	return db.transaction(async (tx) => {
		const now = new Date();
		await lockedCandidate(tx, candidateId);
		const last = await lastSubjectEvent(tx, candidateId, 'fsp_import');
		if (last?.action !== 'grant') {
			throw new ApiError('conflict', { message: 'Согласие на получение достижений ФСП не дано или уже отозвано' });
		}
		const [revocation] = await tx
			.insert(consentEvents)
			.values({
				subjectCandidateId: candidateId,
				kind: 'fsp_import',
				documentId: last.documentId,
				action: 'revoke',
				signerKind: 'subject',
				signerUserId: userId,
				method: 'separate_screen_button',
				evidence: evidenceOf(meta),
				reason: reason?.trim() ? reason.trim() : null,
				occurredAt: now
			})
			.returning({ id: consentEvents.id });
		if (!revocation) throw new Error('consent event was not inserted');
		const actor = auditActor(subject, meta, 'candidate');
		await recordAuditEvent(tx, {
			action: 'consent.revoked',
			outcome: 'success',
			actor,
			object: { type: 'consent_event', id: revocation.id },
			subjectCandidateId: candidateId,
			requestId: meta.requestId,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null,
			details: { kind: 'fsp_import' },
			occurredAt: now
		});
		return withdrawFspImport(tx, {
			candidateId,
			userId,
			revocationId: revocation.id,
			at: now,
			actor,
			requestId: meta.requestId,
			createdBy: { kind: 'user', id: userId }
		});
	});
}

/** The import of FSP achievements as the page of consents shows it. */
export interface FspImportConsentState {
	/** The candidate's own side is given. */
	subjectGranted: boolean;
	/** `effectiveConsent(fsp_import)` right now: the imports run. */
	effective: boolean;
	grantedAt: Date | null;
	/** When the candidate revoked it last, if the last own event is a revocation. */
	revokedAt: Date | null;
	/** Facts of the source in the profile now. */
	facts: number;
}

export async function fspImportConsentState(
	db: Database,
	candidateId: string,
	now: Date
): Promise<FspImportConsentState> {
	const last = await lastSubjectEvent(db, candidateId, 'fsp_import');
	const [counted] = await db
		.select({ n: count() })
		.from(sourceFacts)
		.where(
			and(eq(sourceFacts.candidateId, candidateId), eq(sourceFacts.source, 'fsp'), eq(sourceFacts.status, 'active'))
		);
	return {
		subjectGranted: last?.action === 'grant',
		effective: (await effectiveConsentOf(db, candidateId, 'fsp_import', now)) !== null,
		grantedAt: last?.action === 'grant' ? last.occurredAt : null,
		revokedAt: last?.action === 'revoke' ? last.occurredAt : null,
		facts: counted?.n ?? 0
	};
}

/** A consent document as the screen of the consent shows it. */
export interface ConsentText {
	id: string;
	title: string;
	version: number;
	body: string;
}

async function consentText(
	executor: Executor,
	kind: ConsentKind | 'pd_processing',
	now: Date
): Promise<ConsentText | null> {
	const document = await currentDocument(executor, kind, now);
	if (!document?.available) return null;
	return { id: document.id, title: document.title, version: document.version, body: document.body };
}

/** The ground of processing the profile (domain 6.3, 19.1) as the candidate sees it. */
export interface ProcessingConsentState {
	regime: 'adult' | 'minor' | 'unknown';
	/** The candidate's own side is in force: not signed during minority, not replaced by a text that asks again. */
	ownSigned: boolean;
	/** Processing is allowed now (for 14–17 with the representative's side as well). */
	effective: boolean;
	/** The text to sign when the own side is not in force; `null` — nothing to sign. */
	document: ConsentText | null;
}

export async function processingConsentState(
	db: Database,
	candidateId: string,
	now: Date
): Promise<ProcessingConsentState> {
	const [row] = await db
		.select({
			birthDate: candidates.birthDate,
			precision: candidates.birthDatePrecision,
			status: candidates.birthDateStatus
		})
		.from(candidates)
		.where(eq(candidates.id, candidateId));
	if (!row) throw new Error(`candidate ${candidateId} disappeared`);
	const band = ageBand(row, now);
	const ownSigned = await ownProcessingConsent(db, candidateId, now);
	return {
		regime: band === 'adult' ? 'adult' : isMinorBand(band) ? 'minor' : 'unknown',
		ownSigned,
		effective: await processingAllowed(db, candidateId, now),
		document: ownSigned ? null : await consentText(db, 'pd_processing', now)
	};
}

/** Why the catalog does not show the candidate right now; `null` — verified companies find the profile. */
export type HiddenReason =
	| 'hidden_by_candidate'
	| 'not_looking'
	| 'no_catalog_consent'
	| 'representative_consent_missing'
	| 'minor_vacancy_context'
	| 'minors_disabled'
	| 'age_unknown';

export interface DisclosureConsentView {
	invitationId: string;
	companyName: string;
	vacancyTitle: string;
	/** Fields the company may receive now; empty — the consent was revoked. */
	fields: DisclosureField[];
	/** What has actually been handed over, by moment. */
	disclosed: { fields: string[]; at: Date }[];
}

export interface ConsentOverview {
	ageRegime: 'adult' | 'minor' | 'unknown';
	representativeVerified: boolean;
	visibility: 'hidden' | 'catalog';
	searchStatus: 'active' | 'open_to_offers' | 'not_looking';
	catalog: {
		/** The candidate's own side of the consent is given (for 14–17 the representative's is needed as well). */
		subjectGranted: boolean;
		/** `effectiveConsent(catalog_visibility)` right now. */
		effective: boolean;
		scopeFields: CatalogScopeField[];
		grantedAt: Date | null;
	};
	hiddenReason: HiddenReason | null;
	telegram: { subjectGranted: boolean; effective: boolean };
	disclosures: DisclosureConsentView[];
	texts: { catalog: ConsentText | null; telegram: ConsentText | null };
}

export async function consentOverview(db: Database, candidateId: string, now: Date): Promise<ConsentOverview> {
	const policy = await loadVisibilityPolicy(db, now);
	const facts = (await loadVisibilityFacts(db, [candidateId], { now, policy, viewerCompanyId: null })).get(candidateId);
	if (!facts) throw new ApiError('not_found');
	const band = ageBand(facts.candidate.birth, now);
	const minor = isMinorBand(band);
	const ageRegime = band === 'adult' ? 'adult' : minor ? 'minor' : 'unknown';
	const catalogEvent = await lastSubjectEvent(db, candidateId, 'catalog_visibility');
	const telegramEvent = await lastSubjectEvent(db, candidateId, 'telegram_notifications');
	const [user] = await db.select({ userId: candidates.userId }).from(candidates).where(eq(candidates.id, candidateId));
	if (!user) throw new ApiError('not_found');

	const catalogGrant = facts.consents.catalogVisibility;
	let hiddenReason: HiddenReason | null = null;
	if (ageRegime === 'unknown') hiddenReason = 'age_unknown';
	else if (minor && !policy.minorsEnabled) hiddenReason = 'minors_disabled';
	else if (facts.candidate.visibility !== 'catalog') hiddenReason = 'hidden_by_candidate';
	else if (facts.candidate.searchStatus === 'not_looking') hiddenReason = 'not_looking';
	else if (!catalogGrant)
		hiddenReason = catalogEvent?.action === 'grant' ? 'representative_consent_missing' : 'no_catalog_consent';
	else if (minor) hiddenReason = 'minor_vacancy_context';

	return {
		ageRegime,
		representativeVerified: facts.representativeVerified,
		visibility: facts.candidate.visibility,
		searchStatus: facts.candidate.searchStatus,
		catalog: {
			subjectGranted: catalogEvent?.action === 'grant',
			effective: catalogGrant !== null,
			scopeFields: catalogGrant ? [...catalogGrant.scopeFields] : [],
			grantedAt: catalogEvent?.action === 'grant' ? catalogEvent.occurredAt : null
		},
		hiddenReason,
		telegram: {
			subjectGranted: telegramEvent?.action === 'grant',
			effective: (await effectiveTelegramConsent(db, user.userId, now)) !== null
		},
		disclosures: await disclosureConsents(db, candidateId, now),
		texts: {
			catalog: await consentText(db, 'catalog_visibility', now),
			telegram: await consentText(db, 'telegram_notifications', now)
		}
	};
}

/** Invitations whose company received or may receive the candidate's contacts, with what was handed over. */
async function disclosureConsents(db: Database, candidateId: string, now: Date): Promise<DisclosureConsentView[]> {
	const granted = await db
		.selectDistinct({ invitationId: consentEvents.scopeInvitationId })
		.from(consentEvents)
		.where(
			and(
				eq(consentEvents.subjectCandidateId, candidateId),
				eq(consentEvents.kind, 'contact_disclosure'),
				eq(consentEvents.action, 'grant')
			)
		);
	const ids = granted.flatMap((row) => (row.invitationId ? [row.invitationId] : []));
	if (ids.length === 0) return [];
	const rows = await db
		.select({
			id: invitations.id,
			companyName: companies.displayName,
			snapshot: invitationTerms.vacancySnapshot,
			sentAt: invitations.sentAt
		})
		.from(invitations)
		.innerJoin(companies, eq(companies.id, invitations.companyId))
		.innerJoin(invitationTerms, eq(invitationTerms.id, invitations.currentTermsId))
		.where(and(inArray(invitations.id, ids), eq(invitations.candidateId, candidateId), isNull(invitations.purgedAt)))
		.orderBy(desc(invitations.sentAt));
	const log = await db
		.select({ invitationId: disclosures.invitationId, fields: disclosures.fields, at: disclosures.disclosedAt })
		.from(disclosures)
		.where(and(eq(disclosures.candidateId, candidateId), inArray(disclosures.invitationId, ids)))
		.orderBy(asc(disclosures.disclosedAt));
	const views: DisclosureConsentView[] = [];
	for (const row of rows) {
		const effective = await effectiveDisclosure(db, candidateId, { invitationId: row.id }, now);
		views.push({
			invitationId: row.id,
			companyName: row.companyName,
			vacancyTitle: (row.snapshot as VacancySnapshot).title,
			fields: effective?.fields ?? [],
			disclosed: log
				.filter((entry) => entry.invitationId === row.id)
				.map((entry) => ({ fields: entry.fields, at: entry.at }))
		});
	}
	return views;
}

/** The Telegram consent of the candidate for the notification settings, with the text to consent to. */
export async function telegramConsentState(
	db: Database,
	candidateId: string,
	userId: string,
	now: Date
): Promise<ConsentOverview['telegram'] & { text: ConsentText | null }> {
	const last = await lastSubjectEvent(db, candidateId, 'telegram_notifications');
	return {
		subjectGranted: last?.action === 'grant',
		effective: (await effectiveTelegramConsent(db, userId, now)) !== null,
		text: await consentText(db, 'telegram_notifications', now)
	};
}

// --- Pool of competition partners (domain 5.5) --------------------------------------------------------------------

/** The last event the candidate signed of `partner_pool` for the competition. */
async function lastPoolEvent(executor: Executor, candidateId: string, competitionRef: string) {
	const [row] = await executor
		.select({
			id: consentEvents.id,
			action: consentEvents.action,
			documentId: consentEvents.documentId,
			choices: consentEvents.choices,
			occurredAt: consentEvents.occurredAt
		})
		.from(consentEvents)
		.where(
			and(
				eq(consentEvents.subjectCandidateId, candidateId),
				eq(consentEvents.kind, 'partner_pool'),
				eq(consentEvents.scopeCompetitionRef, competitionRef),
				eq(consentEvents.signerKind, 'subject')
			)
		)
		.orderBy(desc(consentEvents.occurredAt), desc(consentEvents.id))
		.limit(1);
	return row ?? null;
}

/**
 * The partnerships open now that the candidate's demo session sees, each with the candidate's best result of its
 * competition that fits its pool rule; partnerships whose rule no result fits are left out.
 */
async function fittingPartnerships(
	executor: Executor,
	candidateId: string,
	demoSessionId: string | null,
	now: Date,
	competitionRef?: string
): Promise<{ partnership: OpenPartnership; result: CompetitionResult }[]> {
	const results = await competitionResults(executor, { candidateId });
	const partnerships = await openPartnerships(executor, {
		now,
		viewerSession: demoSessionId,
		...(competitionRef === undefined ? {} : { competitionRef })
	});
	return partnerships.flatMap((partnership) => {
		const fitting = results.filter(
			(result) => result.competition.id === partnership.competitionRef && fitsPoolRule(partnership.poolRule, result)
		);
		const best = fitting.sort((a, b) => (a.result.place ?? Infinity) - (b.result.place ?? Infinity))[0];
		return best ? [{ partnership, result: best }] : [];
	});
}

async function poolCandidate(executor: Executor, candidateId: string) {
	const [row] = await executor
		.select({ demoSessionId: candidates.demoSessionId })
		.from(candidates)
		.where(eq(candidates.id, candidateId));
	if (!row) throw new ApiError('not_found');
	return row;
}

/**
 * The candidate shows the card to the partners of one competition where they are a finalist (domain 5.5): a `grant` of
 * `partner_pool` with the competition as its area and the partners open right now in `choices`. A partner added later
 * sees nothing until the next consent. Only an adult signs it (domain 6.2): 14–17 stay out of every pool.
 */
export async function grantPartnerPoolConsent(
	db: Database,
	subject: AccessSubject,
	meta: RequestMeta,
	input: { documentId: string; competitionRef: string }
): Promise<{ partnerCompanyIds: string[] }> {
	const { candidateId, userId } = writableCandidate(subject);
	return db.transaction(async (tx) => {
		const now = new Date();
		const candidate = await lockedCandidate(tx, candidateId);
		const band = ageBand(
			{ birthDate: candidate.birthDate, precision: candidate.precision, status: candidate.birthStatus },
			now
		);
		if (band !== 'adult') {
			throw new ApiError('forbidden', { message: 'Пул партнёров соревнований доступен только с 18 лет' });
		}
		const { demoSessionId } = await poolCandidate(tx, candidateId);
		const partners = await fittingPartnerships(tx, candidateId, demoSessionId, now, input.competitionRef);
		if (partners.length === 0) {
			throw new ApiError('conflict', {
				message: 'У этого соревнования нет действующих партнёров, в чей пул входит ваш результат'
			});
		}
		const document = await currentText(tx, 'partner_pool', input.documentId, now);
		const choices: PoolChoices = {
			partner_company_ids: [...new Set(partners.map(({ partnership }) => partnership.companyId))].sort()
		};
		const [grant] = await tx
			.insert(consentEvents)
			.values({
				subjectCandidateId: candidateId,
				kind: 'partner_pool',
				documentId: document.id,
				action: 'grant',
				signerKind: 'subject',
				signerUserId: userId,
				scopeCompetitionRef: input.competitionRef,
				choices,
				method: 'separate_screen_button',
				evidence: evidenceOf(meta, document),
				occurredAt: now
			})
			.returning({ id: consentEvents.id });
		if (!grant) throw new Error('consent event was not inserted');
		await recordAuditEvent(tx, {
			action: 'consent.granted',
			outcome: 'success',
			actor: auditActor(subject, meta, 'candidate'),
			object: { type: 'consent_event', id: grant.id },
			subjectCandidateId: candidateId,
			requestId: meta.requestId,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null,
			details: {
				kind: 'partner_pool',
				document_version: document.version,
				competition_ref: input.competitionRef,
				partner_count: choices.partner_company_ids.length
			},
			occurredAt: now
		});
		return { partnerCompanyIds: choices.partner_company_ids };
	});
}

/** The candidate leaves the pool of the competition's partners at once: a `revoke` of `partner_pool` of its area. */
export async function revokePartnerPoolConsent(
	db: Database,
	subject: AccessSubject,
	meta: RequestMeta,
	competitionRef: string,
	reason?: string
): Promise<void> {
	const { candidateId, userId } = writableCandidate(subject);
	await db.transaction(async (tx) => {
		const now = new Date();
		await lockedCandidate(tx, candidateId);
		const last = await lastPoolEvent(tx, candidateId, competitionRef);
		if (last?.action !== 'grant') throw new ApiError('conflict', { message: 'Показ в пуле партнёров уже выключен' });
		const [revocation] = await tx
			.insert(consentEvents)
			.values({
				subjectCandidateId: candidateId,
				kind: 'partner_pool',
				documentId: last.documentId,
				action: 'revoke',
				signerKind: 'subject',
				signerUserId: userId,
				scopeCompetitionRef: competitionRef,
				method: 'separate_screen_button',
				evidence: evidenceOf(meta),
				reason: reason?.trim() ? reason.trim() : null,
				occurredAt: now
			})
			.returning({ id: consentEvents.id });
		if (!revocation) throw new Error('consent event was not inserted');
		await recordAuditEvent(tx, {
			action: 'consent.revoked',
			outcome: 'success',
			actor: auditActor(subject, meta, 'candidate'),
			object: { type: 'consent_event', id: revocation.id },
			subjectCandidateId: candidateId,
			requestId: meta.requestId,
			ip: meta.ip ?? null,
			userAgent: meta.userAgent ?? null,
			details: { kind: 'partner_pool', competition_ref: competitionRef },
			occurredAt: now
		});
	});
}

/** One competition of the candidate's pools: the result, the partners open now and the consent. */
export interface PartnerPoolOffer {
	competitionRef: string;
	/** `null` — the result of the competition is no longer in the profile; the consent can still be revoked. */
	competition: { title: string; stage: string | null; startDate: string } | null;
	result: CompetitionResult['result'] | null;
	/** Partners open now whose pool rule the result fits. */
	partners: { companyId: string; name: string }[];
	/** The candidate's own consent given last, with the partners it names. */
	consent: { grantedAt: Date; partners: string[]; effective: boolean } | null;
	/** Open partners the consent does not name: they see nothing until a new consent. */
	newPartners: string[];
}

export interface PartnerPoolOverview {
	/** Only an adult signs `partner_pool`. */
	adult: boolean;
	offers: PartnerPoolOffer[];
	text: ConsentText | null;
}

/** The competitions where the candidate is in a partner's pool or has consented to one, the latest first. */
export async function partnerPoolOverview(db: Database, candidateId: string, now: Date): Promise<PartnerPoolOverview> {
	const [candidate] = await db
		.select({
			birthDate: candidates.birthDate,
			precision: candidates.birthDatePrecision,
			status: candidates.birthDateStatus,
			demoSessionId: candidates.demoSessionId
		})
		.from(candidates)
		.where(eq(candidates.id, candidateId));
	if (!candidate) throw new ApiError('not_found');
	const fitting = await fittingPartnerships(db, candidateId, candidate.demoSessionId, now);
	const consented = await db
		.selectDistinct({ competitionRef: consentEvents.scopeCompetitionRef })
		.from(consentEvents)
		.where(
			and(
				eq(consentEvents.subjectCandidateId, candidateId),
				eq(consentEvents.kind, 'partner_pool'),
				eq(consentEvents.signerKind, 'subject')
			)
		);
	const refs = new Set([
		...fitting.map(({ partnership }) => partnership.competitionRef),
		...consented.flatMap((row) => (row.competitionRef === null ? [] : [row.competitionRef]))
	]);
	const results = await competitionResults(db, { candidateId });
	const offers: PartnerPoolOffer[] = [];
	for (const competitionRef of refs) {
		const partners = fitting.filter(({ partnership }) => partnership.competitionRef === competitionRef);
		const last = await lastPoolEvent(db, candidateId, competitionRef);
		const listed = last?.action === 'grant' ? listedPartners(last.id, last.choices) : [];
		if (partners.length === 0 && last?.action !== 'grant') continue;
		const names = new Map(
			listed.length === 0
				? []
				: (
						await db
							.select({ id: companies.id, name: companies.displayName })
							.from(companies)
							.where(inArray(companies.id, listed))
					).map((row) => [row.id, row.name])
		);
		const shown = partners[0]?.result ?? results.find((result) => result.competition.id === competitionRef) ?? null;
		const effective = (await effectivePoolGrants(db, [candidateId], competitionRef, now)).has(candidateId);
		offers.push({
			competitionRef,
			competition: shown && {
				title: shown.competition.title,
				stage: shown.competition.stage ?? null,
				startDate: shown.competition.startDate
			},
			result: shown?.result ?? null,
			partners: partners.map(({ partnership }) => ({
				companyId: partnership.companyId,
				name: partnership.companyName
			})),
			consent:
				last?.action === 'grant'
					? {
							grantedAt: last.occurredAt,
							partners: listed.map((id) => {
								const name = names.get(id);
								if (name === undefined)
									throw new Error(`partner ${id} of partner_pool grant ${last.id} does not exist`);
								return name;
							}),
							effective
						}
					: null,
			newPartners: partners
				.filter(({ partnership }) => !listed.includes(partnership.companyId))
				.map(({ partnership }) => partnership.companyName)
		});
	}
	offers.sort((a, b) => (b.competition?.startDate ?? '').localeCompare(a.competition?.startDate ?? ''));
	return {
		adult:
			ageBand({ birthDate: candidate.birthDate, precision: candidate.precision, status: candidate.status }, now) ===
			'adult',
		offers,
		text: await consentText(db, 'partner_pool', now)
	};
}

function listedPartners(grantId: string, choices: unknown): string[] {
	const parsed = poolChoicesSchema.safeParse(choices);
	if (!parsed.success) throw new Error(`partner_pool grant ${grantId} does not list the partners`);
	return parsed.data.partner_company_ids;
}
